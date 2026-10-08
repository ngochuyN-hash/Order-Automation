"""
Unit tests for excel_automation.py — pure helper functions.
Run: python -m unittest test/test_excel_automation.py -v
"""
import sys
import os
import unittest

# Allow importing from project root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from excel_automation import (
    extract_seq_from_title, col_letter,
    extract_vlookup_expr, wrap_vlookup_formula,
)


class TestExtractSeqFromTitle(unittest.TestCase):
    """extract_seq_from_title: parse sequence number from order title."""

    def test_standard_format(self):
        self.assertEqual(extract_seq_from_title('AUXSG2607-16-Phúc-CH-3%'), 16)

    def test_single_digit_seq(self):
        self.assertEqual(extract_seq_from_title('RE2607-1-Khách-A'), 1)

    def test_large_seq_number(self):
        self.assertEqual(extract_seq_from_title('RA2607-128-Shop-B'), 128)

    def test_returns_none_for_empty_string(self):
        self.assertIsNone(extract_seq_from_title(''))

    def test_returns_none_for_none(self):
        self.assertIsNone(extract_seq_from_title(None))

    def test_returns_none_for_no_match(self):
        self.assertIsNone(extract_seq_from_title('no-sequence-here'))


class TestColLetter(unittest.TestCase):
    """col_letter: 1-based index → Excel column letter (app uses ≤ 15 cols)."""

    def test_first_column(self):
        self.assertEqual(col_letter(1), 'A')

    def test_column_z(self):
        self.assertEqual(col_letter(26), 'Z')


class TestVLookupFormulaWrapping(unittest.TestCase):
    """VLOOKUP formula extraction and error-cleanup wrapping."""

    def test_extract_vlookup_expr_standard(self):
        raw = "=VLOOKUP(B21,Table1[#All],6,0)"
        extracted = extract_vlookup_expr(raw)
        self.assertEqual(extracted, "VLOOKUP(B21,Table1[#All],6,0)")

    def test_extract_vlookup_expr_isna_wrapped(self):
        raw = '=IF(ISNA(VLOOKUP(B20,Table1[],3,0)),"",VLOOKUP(B20,Table1[],3,0))'
        extracted = extract_vlookup_expr(raw)
        self.assertEqual(extracted, "VLOOKUP(B20,Table1[],3,0)")

    def test_wrap_vlookup_formula(self):
        raw = "=VLOOKUP(B21,Table1[#All],6,0)"
        wrapped = wrap_vlookup_formula(raw)
        expected = '=IFERROR(IF(OR(VLOOKUP(B21,Table1[#All],6,0)=0, VLOOKUP(B21,Table1[#All],6,0)="0", VLOOKUP(B21,Table1[#All],6,0)=""), "", VLOOKUP(B21,Table1[#All],6,0)), "")'
        self.assertEqual(wrapped, expected)

    def test_no_double_wrapping(self):
        raw = "=VLOOKUP(B20,Table1[],3,0)"
        wrapped = wrap_vlookup_formula(raw)
        self.assertEqual(wrap_vlookup_formula(wrapped), wrapped)


if __name__ == '__main__':
    unittest.main()
