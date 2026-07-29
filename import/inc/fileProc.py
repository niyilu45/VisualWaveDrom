#!/usr/bin/env python3
from __future__ import print_function

import argparse
import csv
import io
import json
import re
import sys


# Custom functions only need to parse a file into:
# {"points": [{"index": 0, "value": "0"}, ...], "explicitIndex": true}
# Register the function in FILE_PARSERS. The built-in completion step handles
# missing indices and converts the point list into WaveDrom wave/data fields.
WAVE_SYMBOLS = set("01xzpnPNhHlLuUdD.|=23456789")
DATA_SYMBOLS = set("=23456789")


class FileProcError(Exception):
    pass


def _positive_int(value, name, default_value):
    if value is None:
        return default_value
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise FileProcError("%s must be an integer" % name)
    if parsed < 0:
        raise FileProcError("%s must not be negative" % name)
    return parsed


def _read_text(file_path, options):
    encoding = str(options.get("encoding") or "utf-8-sig")
    try:
        with io.open(file_path, "r", encoding=encoding, newline="") as handle:
            return handle.read()
    except (IOError, OSError, UnicodeError) as error:
        raise FileProcError("cannot read source file: %s" % error)


def _split_line(line, delimiter):
    if delimiter in ("comma", "csv", ","):
        return next(csv.reader([line], delimiter=","))
    if delimiter in ("tab", "tsv", "\\t", "\t"):
        return next(csv.reader([line], delimiter="\t"))
    if delimiter in ("space", "whitespace"):
        return re.split(r"\s+", line.strip(), maxsplit=1)
    if delimiter not in ("", "auto", None):
        delimiter_text = str(delimiter)
        if len(delimiter_text) != 1:
            raise FileProcError("delimiter must be auto, comma, tab, whitespace, or one character")
        return next(csv.reader([line], delimiter=delimiter_text))
    if "\t" in line:
        return next(csv.reader([line], delimiter="\t"))
    if "," in line:
        return next(csv.reader([line], delimiter=","))
    return re.split(r"\s+", line.strip(), maxsplit=1)


def _data_rows(text, options):
    delimiter = options.get("delimiter", "auto")
    prefixes = options.get("commentPrefixes", ["#", "//"])
    if not isinstance(prefixes, list):
        raise FileProcError("commentPrefixes must be an array")
    prefixes = [str(item) for item in prefixes if str(item)]
    skip_rows = _positive_int(options.get("skipRows"), "skipRows", 0)
    rows = []
    skipped = 0
    for line_number, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line or any(line.startswith(prefix) for prefix in prefixes):
            continue
        if skipped < skip_rows:
            skipped += 1
            continue
        try:
            columns = [str(value).strip() for value in _split_line(raw_line, delimiter)]
        except (csv.Error, StopIteration) as error:
            raise FileProcError("line %d cannot be parsed: %s" % (line_number, error))
        if not columns or (len(columns) == 1 and columns[0] == ""):
            continue
        if len(columns) > 2:
            raise FileProcError(
                "line %d has more than two columns; quote delimiters inside data values"
                % line_number
            )
        rows.append((line_number, columns))
    if not rows:
        raise FileProcError("source file contains no data rows")
    return rows


def _parse_index(value, line_number):
    text = str(value).strip()
    if not re.match(r"^\+?\d+$", text):
        raise FileProcError("line %d has an invalid sequence number: %s" % (line_number, text))
    index = int(text, 10)
    if index < 0:
        raise FileProcError("line %d sequence number must not be negative" % line_number)
    return index


def _normalize_value(value, options):
    raw = str(value).strip()
    state_map = options.get("stateMap", {})
    if not isinstance(state_map, dict):
        raise FileProcError("stateMap must be an object")
    mapped = str(state_map.get(raw, raw))
    if mapped == "":
        return "x", ""
    if mapped.lower() == "unknown":
        mapped = "x"
    elif mapped.lower() in ("high", "true"):
        mapped = "1"
    elif mapped.lower() in ("low", "false"):
        mapped = "0"
    elif mapped in ("X", "Z"):
        mapped = mapped.lower()

    value_mode = str(options.get("valueMode") or "auto").lower()
    if value_mode == "data":
        return "=", mapped
    if len(mapped) == 1 and mapped in WAVE_SYMBOLS:
        return mapped, ""
    if value_mode == "wave":
        raise FileProcError("unsupported WaveDrom symbol: %s" % mapped)
    if value_mode != "auto":
        raise FileProcError("valueMode must be auto, wave, or data")
    return "=", mapped


def parse_index_data(file_path, options=None):
    opts = dict(options or {})
    rows = _data_rows(_read_text(file_path, opts), opts)
    max_columns = _positive_int(opts.get("maxColumns"), "maxColumns", 10000000)
    if max_columns < 1:
        raise FileProcError("maxColumns must be at least 1")
    if len(rows) > max_columns:
        raise FileProcError("source file exceeds maxColumns")
    column_counts = set(len(columns) for _, columns in rows)
    has_single_column = 1 in column_counts
    has_index_column = any(count >= 2 for count in column_counts)
    if has_single_column and has_index_column:
        raise FileProcError("single-column and indexed rows cannot be mixed")

    points = []
    if has_index_column:
        previous_index = -1
        for line_number, columns in rows:
            index = _parse_index(columns[0], line_number)
            if index >= max_columns:
                raise FileProcError(
                    "line %d sequence number exceeds maxColumns" % line_number
                )
            if index <= previous_index:
                raise FileProcError(
                    "line %d sequence number must be greater than %d" % (line_number, previous_index)
                )
            previous_index = index
            points.append({
                "index": index,
                "value": columns[1],
                "lineNumber": line_number
            })
    else:
        points = [
            {
                "index": index,
                "value": columns[0],
                "lineNumber": line_number
            }
            for index, (line_number, columns) in enumerate(rows)
        ]

    return {
        "points": points,
        "explicitIndex": has_index_column,
        "sourceRowCount": len(rows)
    }


def parse_csv_index_data(file_path, options=None):
    opts = dict(options or {})
    opts["delimiter"] = "comma"
    return parse_index_data(file_path, opts)


def parse_tsv_index_data(file_path, options=None):
    opts = dict(options or {})
    opts["delimiter"] = "tab"
    return parse_index_data(file_path, opts)


def parse_single_column(file_path, options=None):
    result = parse_index_data(file_path, options)
    if result["explicitIndex"]:
        raise FileProcError("parse_single_column requires a one-column source file")
    return result


def _validated_points(parsed_signal, options):
    if not isinstance(parsed_signal, dict):
        raise FileProcError("file parser must return an object")
    points = parsed_signal.get("points")
    if not isinstance(points, list) or not points:
        raise FileProcError("file parser must return a non-empty points array")
    max_columns = _positive_int(options.get("maxColumns"), "maxColumns", 10000000)
    if max_columns < 1:
        raise FileProcError("maxColumns must be at least 1")
    if len(points) > max_columns:
        raise FileProcError("parsed signal exceeds maxColumns")

    normalized = []
    previous_index = -1
    for point_number, point in enumerate(points, 1):
        if not isinstance(point, dict):
            raise FileProcError("parsed point %d must be an object" % point_number)
        index = point.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise FileProcError("parsed point %d has an invalid index" % point_number)
        if index >= max_columns:
            raise FileProcError("parsed point %d exceeds maxColumns" % point_number)
        if index <= previous_index:
            raise FileProcError(
                "parsed point %d index must be greater than %d"
                % (point_number, previous_index)
            )
        previous_index = index
        normalized.append({
            "index": index,
            "value": str(point.get("value", "")),
            "lineNumber": point.get("lineNumber")
        })
    return normalized


def complete_previous_value(parsed_signal, options=None):
    opts = dict(options or {})
    points = _validated_points(parsed_signal, opts)
    fill_leading = str(opts.get("fillLeading", opts.get("fillMissing", "x")) or "x")
    fill_gap = str(opts.get("fillGap") or ".")
    if len(fill_leading) != 1 or fill_leading not in WAVE_SYMBOLS:
        raise FileProcError("fillLeading must be one WaveDrom symbol")
    if len(fill_gap) != 1 or fill_gap not in WAVE_SYMBOLS:
        raise FileProcError("fillGap must be one WaveDrom symbol")

    wave_parts = []
    data_values = []
    cursor = 0
    has_previous_value = False
    for point in points:
        index = point["index"]
        while cursor < index:
            wave_parts.append(fill_gap if has_previous_value else fill_leading)
            cursor += 1
        wave_symbol, data_label = _normalize_value(point["value"], opts)
        wave_parts.append(wave_symbol)
        if wave_symbol in DATA_SYMBOLS:
            data_values.append(data_label)
        cursor = index + 1
        has_previous_value = True

    if not any(value != "" for value in data_values):
        data_values = []
    return {
        "wave": "".join(wave_parts),
        "data": data_values,
        "pointCount": len(points),
        "firstIndex": points[0]["index"],
        "lastIndex": points[-1]["index"],
        "explicitIndex": bool(parsed_signal.get("explicitIndex"))
    }


FILE_PARSERS = {
    "parse_index_data": parse_index_data,
    "parse_csv_index_data": parse_csv_index_data,
    "parse_tsv_index_data": parse_tsv_index_data,
    "parse_single_column": parse_single_column
}


def _parse_args(argv):
    parser = argparse.ArgumentParser(description="VisualWaveDrom row waveform file parser")
    parser.add_argument("--parser", help="registered file parser function name")
    parser.add_argument("--function", dest="legacy_parser", help=argparse.SUPPRESS)
    parser.add_argument("--file", required=True, help="source data file")
    parser.add_argument("--options-json", default="{}", help="parser options as JSON")
    return parser.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)
    parser_name = args.parser or args.legacy_parser
    if not parser_name:
        raise FileProcError("--parser is required")
    parser_function = FILE_PARSERS.get(parser_name)
    if parser_function is None:
        raise FileProcError(
            "unknown parser function %s; available functions: %s"
            % (parser_name, ", ".join(sorted(FILE_PARSERS.keys())))
        )
    try:
        options = json.loads(args.options_json)
    except (TypeError, ValueError) as error:
        raise FileProcError("options-json is invalid: %s" % error)
    if not isinstance(options, dict):
        raise FileProcError("options-json must contain an object")
    parsed_signal = parser_function(args.file, options)
    result = complete_previous_value(parsed_signal, options)
    result["parser"] = parser_name
    result["completion"] = "complete_previous_value"
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except FileProcError as error:
        sys.stderr.write("fileProc: %s\n" % error)
        sys.exit(2)
    except Exception as error:
        sys.stderr.write("fileProc: unexpected error: %s\n" % error)
        sys.exit(3)
