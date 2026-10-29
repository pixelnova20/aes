import unittest

from app.question_parser import parse_markdown, validate_question_numbers


class QuestionNumberValidationTest(unittest.TestCase):
    def test_duplicate_numbers_across_types_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "题号重复：1"):
            parse_markdown("# Chapter\n## 选择题\n1. First\n## 综合题\n1. Second")

    def test_unique_numbers_across_types_are_preserved(self):
        _, questions = parse_markdown(
            "# Chapter\n## 选择题\n1. First\n## 综合题\n2. Second"
        )
        self.assertEqual([q[1] for q in questions], [1, 2])

    def test_publish_validation_reports_all_duplicates(self):
        with self.assertRaisesRegex(ValueError, "题号重复：1、3"):
            validate_question_numbers(iter([3, 1, 3, 1]))
