import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree


class PresentationConversionError(Exception):
    pass


def _run(command, timeout):
    try:
        return subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise PresentationConversionError(f"缺少转换工具：{command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise PresentationConversionError("PPT 转换超时。") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "未知错误").strip()
        raise PresentationConversionError(f"PPT 转换失败：{detail[-600:]}") from error


def extract_pptx_text(source_path):
    if not str(source_path).lower().endswith(".pptx"):
        return {}
    texts = {}
    try:
        with zipfile.ZipFile(source_path) as archive:
            names = [
                name for name in archive.namelist()
                if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
            ]
            for name in names:
                number = int(re.search(r"slide(\d+)\.xml$", name).group(1))
                root = ElementTree.fromstring(archive.read(name))
                chunks = [
                    element.text.strip()
                    for element in root.iter()
                    if element.tag.endswith("}t") and element.text and element.text.strip()
                ]
                texts[number - 1] = "\n".join(chunks)
    except (zipfile.BadZipFile, ElementTree.ParseError):
        return {}
    return texts


class PresentationConverter:
    def __init__(self, libreoffice_bin, pdftoppm_bin, timeout=300):
        self.libreoffice_bin = libreoffice_bin
        self.pdftoppm_bin = pdftoppm_bin
        self.timeout = timeout

    def convert(self, source_path, presentation_dir):
        presentation_dir = Path(presentation_dir)
        slides_dir = presentation_dir / "slides"
        shutil.rmtree(slides_dir, ignore_errors=True)
        slides_dir.mkdir(parents=True, mode=0o700)
        extracted_text = extract_pptx_text(source_path)

        with tempfile.TemporaryDirectory(prefix="slideshow-convert-") as work_dir:
            profile_dir = Path(work_dir) / "lo-profile"
            output_dir = Path(work_dir) / "output"
            profile_dir.mkdir()
            output_dir.mkdir()
            profile_uri = profile_dir.resolve().as_uri()
            _run(
                [
                    self.libreoffice_bin,
                    "--headless",
                    f"-env:UserInstallation={profile_uri}",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(output_dir),
                    str(source_path),
                ],
                self.timeout,
            )
            pdf_files = list(output_dir.glob("*.pdf"))
            if len(pdf_files) != 1:
                raise PresentationConversionError("LibreOffice 未生成有效 PDF。")
            output_prefix = str(output_dir / "slide")
            _run(
                [
                    self.pdftoppm_bin,
                    "-jpeg",
                    "-r",
                    "144",
                    "-jpegopt",
                    "quality=90",
                    str(pdf_files[0]),
                    output_prefix,
                ],
                self.timeout,
            )
            rendered = sorted(
                output_dir.glob("slide-*.jpg"),
                key=lambda path: int(re.search(r"-(\d+)\.jpg$", path.name).group(1)),
            )
            if not rendered:
                raise PresentationConversionError("PDF 未生成任何幻灯片图片。")

            width = max(3, len(str(len(rendered))))
            slides = []
            for index, image_path in enumerate(rendered):
                filename = f"{index + 1:0{width}d}.jpg"
                target_path = slides_dir / filename
                try:
                    # shutil.move falls back to copy-and-delete when /tmp and the
                    # upload directory are mounted on different filesystems.
                    shutil.move(str(image_path), str(target_path))
                except OSError as error:
                    raise PresentationConversionError(
                        f"无法保存转换后的第 {index + 1} 页。"
                    ) from error
                slides.append({
                    "index": index,
                    "image_filename": filename,
                    "text": extracted_text.get(index, ""),
                })
            return slides
