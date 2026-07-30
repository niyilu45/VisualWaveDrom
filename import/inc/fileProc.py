#!/usr/bin/env python3
from __future__ import print_function

import argparse
import csv
import io
import json
import os
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
        return re.split(r"\s+", line.strip())
    if delimiter not in ("", "auto", None):
        delimiter_text = str(delimiter)
        if len(delimiter_text) != 1:
            raise FileProcError("delimiter must be auto, comma, tab, whitespace, or one character")
        return next(csv.reader([line], delimiter=delimiter_text))
    if "\t" in line:
        return next(csv.reader([line], delimiter="\t"))
    if "," in line:
        return next(csv.reader([line], delimiter=","))
    return re.split(r"\s+", line.strip())


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
        if len(columns) > 4:
            raise FileProcError(
                "line %d has more than four columns; quote delimiters inside data values"
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


def _boolean_option(options, name):
    if name not in options:
        return None
    value = options.get(name)
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("true", "1", "yes", "on"):
        return True
    if text in ("false", "0", "no", "off"):
        return False
    raise FileProcError("%s must be true or false" % name)


def _component_pair(real_value, imag_value):
    real_text = str(real_value).strip()
    imag_text = str(imag_value).strip()
    if real_text.startswith("(") or real_text.startswith("["):
        real_text = real_text[1:].strip()
    if imag_text.endswith(")") or imag_text.endswith("]"):
        imag_text = imag_text[:-1].strip()
    return {"real": real_text, "imag": imag_text}


def _value_from_columns(columns, line_number):
    if len(columns) == 1:
        return columns[0]
    if len(columns) == 2:
        return _component_pair(columns[0], columns[1])
    joined = "".join(columns)
    if "j" in joined.lower() or "i" in joined.lower():
        return joined
    raise FileProcError(
        "line %d has too many data columns; complex data needs I/Q columns or a+bj"
        % line_number
    )


def parse_index_data(file_path, options=None):
    opts = dict(options or {})
    rows = _data_rows(_read_text(file_path, opts), opts)
    max_columns = _positive_int(opts.get("maxColumns"), "maxColumns", 10000000)
    if max_columns < 1:
        raise FileProcError("maxColumns must be at least 1")
    if len(rows) > max_columns:
        raise FileProcError("source file exceeds maxColumns")
    forced_has_index = _boolean_option(opts, "hasIndex")
    column_counts = set(len(columns) for _, columns in rows)
    if forced_has_index is None:
        has_single_column = 1 in column_counts
        has_index_column = any(count >= 2 for count in column_counts)
        if has_single_column and has_index_column:
            raise FileProcError("single-column and indexed rows cannot be mixed")
    else:
        has_index_column = forced_has_index

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
            if len(columns) < 2:
                raise FileProcError(
                    "line %d needs a data column after the sequence number" % line_number
                )
            points.append({
                "index": index,
                "value": _value_from_columns(columns[1:], line_number),
                "lineNumber": line_number
            })
    else:
        points = [
            {
                "index": index,
                "value": _value_from_columns(columns, line_number),
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
    opts = dict(options or {})
    if _boolean_option(opts, "hasIndex"):
        raise FileProcError("parse_single_column cannot be used when the file contains a sequence column")
    opts["hasIndex"] = False
    return parse_index_data(file_path, opts)


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
        value = point.get("value", "")
        if isinstance(value, dict):
            if "real" not in value or "imag" not in value:
                raise FileProcError(
                    "parsed point %d complex value needs real and imag fields" % point_number
                )
            value = {
                "real": str(value.get("real", "")).strip(),
                "imag": str(value.get("imag", "")).strip()
            }
        else:
            value = str(value)
        normalized.append({
            "index": index,
            "value": value,
            "lineNumber": point.get("lineNumber")
        })
    return normalized


_NUMBER_TEXT = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
_PAIR_PATTERN = re.compile(
    r"^\s*[\(\[]\s*(%s)\s*[,;]\s*(%s)\s*[\)\]]\s*$"
    % (_NUMBER_TEXT, _NUMBER_TEXT)
)


def _normalized_number_text(value):
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        raise FileProcError("complex component is not numeric: %s" % value)
    if number != number or number in (float("inf"), float("-inf")):
        raise FileProcError("complex component must be finite: %s" % value)
    if number.is_integer():
        return str(int(number))
    return "%.15g" % number


def _complex_components(value):
    if isinstance(value, dict):
        return (
            _normalized_number_text(value.get("real", "")),
            _normalized_number_text(value.get("imag", ""))
        )
    raw = str(value).strip()
    pair_match = _PAIR_PATTERN.match(raw)
    if pair_match:
        return (
            _normalized_number_text(pair_match.group(1)),
            _normalized_number_text(pair_match.group(2))
        )
    normalized = re.sub(r"\s+", "", raw)
    normalized = normalized.replace("I", "j").replace("i", "j").replace("J", "j")
    if "j" not in normalized:
        return None
    try:
        number = complex(normalized)
    except (TypeError, ValueError):
        raise FileProcError("invalid complex value: %s" % raw)
    return (
        _normalized_number_text(number.real),
        _normalized_number_text(number.imag)
    )


def _complete_scalar_signal(parsed_signal, points, options):
    opts = options
    fill_leading = str(opts.get("fillLeading", opts.get("fillMissing", "x")) or "x")
    fill_gap = str(opts.get("fillGap") or ".")
    if len(fill_leading) != 1 or fill_leading not in WAVE_SYMBOLS:
        raise FileProcError("fillLeading must be one WaveDrom symbol")
    if len(fill_gap) != 1 or fill_gap not in WAVE_SYMBOLS:
        raise FileProcError("fillGap must be one WaveDrom symbol")

    wave_parts = []
    data_values = []
    numeric_values = []
    all_numeric = True
    for point in points:
        try:
            number = float(point["value"])
            if number != number or number in (float("inf"), float("-inf")):
                raise ValueError("non-finite number")
            if number.is_integer():
                number = int(number)
            numeric_values.append(number)
        except (TypeError, ValueError):
            all_numeric = False
            numeric_values = []
            break

    samples = []
    cursor = 0
    has_previous_value = False
    previous_numeric_value = None
    for point_number, point in enumerate(points):
        index = point["index"]
        while cursor < index:
            wave_parts.append(fill_gap if has_previous_value else fill_leading)
            if all_numeric:
                samples.append(previous_numeric_value if has_previous_value else None)
            cursor += 1
        wave_symbol, data_label = _normalize_value(point["value"], opts)
        wave_parts.append(wave_symbol)
        if wave_symbol in DATA_SYMBOLS:
            data_values.append(data_label)
        if all_numeric:
            previous_numeric_value = numeric_values[point_number]
            samples.append(previous_numeric_value)
        cursor = index + 1
        has_previous_value = True

    if not any(value != "" for value in data_values):
        data_values = []
    result = {
        "wave": "".join(wave_parts),
        "data": data_values,
        "pointCount": len(points),
        "firstIndex": points[0]["index"],
        "lastIndex": points[-1]["index"],
        "explicitIndex": bool(parsed_signal.get("explicitIndex"))
    }
    if all_numeric:
        numeric_states = set(value for value in numeric_values)
        result["samples"] = samples
        result["sampleKind"] = (
            "digital"
            if numeric_states.issubset(set([0, 1]))
            and str(opts.get("valueMode") or "auto").lower() != "data"
            else "analog"
        )
    else:
        symbols_only = all(
            len(str(point["value"])) == 1
            and str(point["value"]) in WAVE_SYMBOLS
            for point in points
        )
        result["sampleKind"] = "digital" if symbols_only else "bus"
    return result


def complete_previous_value(parsed_signal, options=None):
    opts = dict(options or {})
    points = _validated_points(parsed_signal, opts)
    detected_components = []
    complex_detected = False
    for point in points:
        components = _complex_components(point["value"])
        detected_components.append(components)
        if components is not None:
            complex_detected = True

    if not complex_detected:
        result = _complete_scalar_signal(parsed_signal, points, opts)
        result["complexDetected"] = False
        return result

    real_points = []
    imag_points = []
    for point, components in zip(points, detected_components):
        if components is None:
            raw_value = str(point["value"]).strip()
            if len(raw_value) == 1 and raw_value in WAVE_SYMBOLS:
                components = (raw_value, raw_value)
            else:
                components = (_normalized_number_text(raw_value), "0")
        common = {
            "index": point["index"],
            "lineNumber": point.get("lineNumber")
        }
        real_point = dict(common)
        real_point["value"] = components[0]
        imag_point = dict(common)
        imag_point["value"] = components[1]
        real_points.append(real_point)
        imag_points.append(imag_point)

    component_base = {
        "explicitIndex": bool(parsed_signal.get("explicitIndex"))
    }
    component_options = dict(opts)
    component_options["valueMode"] = "data"
    real_result = _complete_scalar_signal(component_base, real_points, component_options)
    imag_result = _complete_scalar_signal(component_base, imag_points, component_options)
    real_result["suffix"] = "_I"
    real_result["component"] = "I"
    imag_result["suffix"] = "_Q"
    imag_result["component"] = "Q"
    return {
        "complexDetected": True,
        "channels": [real_result, imag_result],
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


def _normalized_path(value):
    return os.path.normcase(os.path.realpath(os.path.abspath(value)))


def _search_python_regex(payload):
    if not isinstance(payload, dict):
        raise FileProcError("regex search input must be an object")
    raw_roots = payload.get("scanRoots")
    raw_rules = payload.get("rules")
    if not isinstance(raw_roots, list) or not isinstance(raw_rules, list):
        raise FileProcError("regex search requires scanRoots and rules arrays")
    try:
        max_visited = int(payload.get("maxVisitedFiles"))
        max_matches = int(payload.get("maxMatchesPerRule"))
    except (TypeError, ValueError):
        raise FileProcError("regex search limits must be integers")
    if max_visited < 1 or max_matches < 1:
        raise FileProcError("regex search limits must be positive")

    rules = []
    matches = {}
    for position, raw_rule in enumerate(raw_rules):
        if not isinstance(raw_rule, dict):
            raise FileProcError("regex search rule %d must be an object" % position)
        try:
            entry_index = int(raw_rule.get("entryIndex"))
        except (TypeError, ValueError):
            raise FileProcError("regex search rule %d has an invalid entryIndex" % position)
        search_path = _normalized_path(str(raw_rule.get("searchPath") or ""))
        pattern_text = raw_rule.get("pattern")
        if not isinstance(pattern_text, str):
            raise FileProcError("regex search rule %d pattern must be a string" % position)
        try:
            pattern = re.compile(pattern_text)
        except re.error as error:
            raise FileProcError(
                "paths[%d].grepKeys is invalid Python re syntax: %s"
                % (entry_index, error)
            )
        rules.append({
            "entryIndex": entry_index,
            "searchPath": search_path,
            "pattern": pattern
        })
        matches[entry_index] = []

    visited = 0
    for raw_root in raw_roots:
        scan_root = _normalized_path(str(raw_root or ""))
        active_rules = [
            rule for rule in rules
            if rule["searchPath"] == scan_root
        ]
        try:
            with os.scandir(scan_root) as directory_entries:
                for directory_entry in directory_entries:
                    if not directory_entry.is_file(follow_symlinks=False):
                        continue
                    file_name = directory_entry.name
                    source_path = directory_entry.path
                    visited += 1
                    if visited > max_visited:
                        raise FileProcError(
                            "search folders contain more than %d files" % max_visited
                        )
                    for rule in active_rules:
                        if rule["pattern"].search(file_name) is None:
                            continue
                        rule_matches = matches[rule["entryIndex"]]
                        if len(rule_matches) >= max_matches:
                            raise FileProcError(
                                "paths[%d] matched more than %d files"
                                % (rule["entryIndex"], max_matches)
                            )
                        rule_matches.append(source_path)
        except OSError as error:
            raise FileProcError("cannot search folder: %s" % error)

    return {
        "visitedFiles": visited,
        "matches": [
            {"entryIndex": rule["entryIndex"], "paths": matches[rule["entryIndex"]]}
            for rule in rules
        ]
    }


def _parse_args(argv):
    parser = argparse.ArgumentParser(description="VisualWaveDrom row waveform file parser")
    parser.add_argument(
        "--mode",
        choices=("parse", "regex-search"),
        default="parse",
        help="operation mode"
    )
    parser.add_argument("--parser", help="registered file parser function name")
    parser.add_argument("--function", dest="legacy_parser", help=argparse.SUPPRESS)
    parser.add_argument("--file", help="source data file")
    parser.add_argument("--options-json", default="{}", help="parser options as JSON")
    return parser.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)
    if args.mode == "regex-search":
        try:
            payload = json.load(sys.stdin)
        except (TypeError, ValueError) as error:
            raise FileProcError("regex search input is invalid JSON: %s" % error)
        result = _search_python_regex(payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        sys.stdout.write("\n")
        return 0

    if not args.file:
        raise FileProcError("--file is required")
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
