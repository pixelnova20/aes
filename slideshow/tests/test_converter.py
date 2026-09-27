import errno
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from slideshow_app.converter import PresentationConverter, extract_pptx_text


class PresentationConverterTest(unittest.TestCase):
    def test_extracts_text_by_slide_index(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "lesson.pptx"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr(
                    "ppt/slides/slide2.xml",
                    '<p:sld xmlns:p="p" xmlns:a="a"><a:t>第二页标题</a:t><a:t>核心概念</a:t></p:sld>',
                )
                archive.writestr(
                    "ppt/slides/slide1.xml",
                    '<p:sld xmlns:p="p" xmlns:a="a"><a:t>第一页</a:t></p:sld>',
                )
            self.assertEqual(extract_pptx_text(source), {0: "第一页", 1: "第二页标题\n核心概念"})

    @patch("slideshow_app.converter._run")
    def test_conversion_creates_fixed_width_sorted_images(self, run):
        def fake_run(command, _timeout):
            if "--convert-to" in command:
                output = Path(command[command.index("--outdir") + 1])
                (output / "original.pdf").write_bytes(b"pdf")
            else:
                prefix = Path(command[-1])
                (prefix.parent / f"{prefix.name}-2.jpg").write_bytes(b"second")
                (prefix.parent / f"{prefix.name}-1.jpg").write_bytes(b"first")

        run.side_effect = fake_run
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "original.ppt"
            source.write_bytes(b"ppt")
            destination = Path(root) / "presentation"
            slides = PresentationConverter("libreoffice", "pdftoppm").convert(source, destination)
            self.assertEqual([item["image_filename"] for item in slides], ["001.jpg", "002.jpg"])
            self.assertEqual((destination / "slides" / "001.jpg").read_bytes(), b"first")
            self.assertEqual((destination / "slides" / "002.jpg").read_bytes(), b"second")

    @patch("slideshow_app.converter._run")
    def test_conversion_handles_cross_filesystem_move(self, run):
        def fake_run(command, _timeout):
            if "--convert-to" in command:
                output = Path(command[command.index("--outdir") + 1])
                (output / "original.pdf").write_bytes(b"pdf")
            else:
                prefix = Path(command[-1])
                (prefix.parent / f"{prefix.name}-1.jpg").write_bytes(b"first")

        run.side_effect = fake_run
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "original.ppt"
            source.write_bytes(b"ppt")
            destination = Path(root) / "presentation"
            with patch("shutil.os.rename", side_effect=OSError(errno.EXDEV, "Invalid cross-device link")):
                slides = PresentationConverter("libreoffice", "pdftoppm").convert(source, destination)

            self.assertEqual([item["image_filename"] for item in slides], ["001.jpg"])
            self.assertEqual((destination / "slides" / "001.jpg").read_bytes(), b"first")


if __name__ == "__main__":
    unittest.main()
