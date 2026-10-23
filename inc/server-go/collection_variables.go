package main

import (
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
)

const collectionMaxVariableCandidates = 1024
const collectionMaxExpandedRules = 4096

type collectionVariableCombination struct {
	values map[string]string
	suffix string
}

func collectionCandidateNumber(text string) (*big.Rat, int, error) {
	text = strings.TrimSpace(text)
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, 0, fmt.Errorf("候选值 %q 必须是有限数字", text)
	}
	parts := strings.Split(strings.ToLower(text), "e")
	precision := 0
	if point := strings.IndexByte(parts[0], '.'); point >= 0 {
		precision = len(parts[0]) - point - 1
	}
	if len(parts) == 2 {
		exponent, _ := strconv.Atoi(parts[1])
		precision -= exponent
	}
	if precision < 0 {
		precision = 0
	}
	if precision > 324 {
		return nil, 0, fmt.Errorf("候选值 %q 的小数位过多", text)
	}
	number, ok := new(big.Rat).SetString(text)
	if !ok {
		return nil, 0, fmt.Errorf("候选值 %q 不是有效数字", text)
	}
	return number, precision, nil
}

func collectionVariableCandidates(text string) ([]string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return []string{"0"}, nil
	}
	// Preserve legacy scalar strings and zero-padded file identifiers.
	if !strings.ContainsAny(text, ",:") {
		return []string{text}, nil
	}
	values := []string{}
	seen := map[string]bool{}
	appendNumber := func(number *big.Rat, precision int) error {
		value := number.FloatString(precision)
		if strings.Contains(value, ".") {
			value = strings.TrimRight(strings.TrimRight(value, "0"), ".")
		}
		if value == "-0" {
			value = "0"
		}
		if seen[value] {
			return nil
		}
		if len(values) >= collectionMaxVariableCandidates {
			return fmt.Errorf("每个变量最多支持 %d 个候选值", collectionMaxVariableCandidates)
		}
		seen[value] = true
		values = append(values, value)
		return nil
	}
	for _, item := range strings.Split(text, ",") {
		parts := strings.Split(item, ":")
		if len(parts) != 1 && len(parts) != 2 && len(parts) != 3 {
			return nil, fmt.Errorf("区间 %q 应为 起点:终点 或 起点:步长:终点", item)
		}
		numbers := make([]*big.Rat, len(parts))
		precision := 0
		for index, part := range parts {
			number, digits, err := collectionCandidateNumber(part)
			if err != nil {
				return nil, err
			}
			numbers[index] = number
			if digits > precision {
				precision = digits
			}
		}
		if len(parts) == 1 {
			if err := appendNumber(numbers[0], precision); err != nil {
				return nil, err
			}
			continue
		}
		start, end, step := numbers[0], numbers[len(numbers)-1], big.NewRat(1, 1)
		if len(parts) == 3 {
			step = numbers[1]
		}
		if step.Sign() == 0 || (start.Cmp(end) < 0 && step.Sign() < 0) || (start.Cmp(end) > 0 && step.Sign() > 0) {
			return nil, fmt.Errorf("区间 %q 的步长为零或方向不正确", item)
		}
		current := new(big.Rat).Set(start)
		for count := 0; (step.Sign() > 0 && current.Cmp(end) <= 0) || (step.Sign() < 0 && current.Cmp(end) >= 0); count++ {
			if count >= collectionMaxVariableCandidates {
				return nil, fmt.Errorf("每个区间最多支持 %d 个候选值", collectionMaxVariableCandidates)
			}
			if err := appendNumber(current, precision); err != nil {
				return nil, err
			}
			current.Add(current, step)
		}
	}
	return values, nil
}

func expandCollectionVariables(preset collectionPreset, variables map[string]string) ([]collectionVariableCombination, error) {
	combinations := []collectionVariableCombination{{values: map[string]string{}}}
	for _, name := range preset.Vars {
		candidates, err := collectionVariableCandidates(variables[name])
		if err != nil {
			return nil, fmt.Errorf("变量 %s：%w", name, err)
		}
		if len(combinations) > collectionMaxVariableCandidates/len(candidates) {
			return nil, fmt.Errorf("变量组合最多支持 %d 组，请缩小候选范围", collectionMaxVariableCandidates)
		}
		next := make([]collectionVariableCombination, 0, len(combinations)*len(candidates))
		for _, combination := range combinations {
			for _, value := range candidates {
				values := make(map[string]string, len(combination.values)+1)
				for key, previous := range combination.values {
					values[key] = previous
				}
				values[name] = value
				suffix := combination.suffix
				if len(candidates) > 1 {
					suffix += "_" + name + value
				}
				next = append(next, collectionVariableCombination{values: values, suffix: suffix})
			}
		}
		combinations = next
	}
	if len(preset.Paths) > 0 && len(combinations) > collectionMaxExpandedRules/len(preset.Paths) {
		return nil, fmt.Errorf("展开后的搜索规则最多支持 %d 条，请缩小候选范围", collectionMaxExpandedRules)
	}
	return combinations, nil
}

func collectionEntryRuleIndex(entry collectionSearchEntry) int {
	if entry.Expanded {
		return entry.SourceIndex
	}
	return entry.Index
}

func suffixCollectionTableNames(entry *collectionSearchEntry) {
	if entry.ImportMode != "table" || entry.NameSuffix == "" {
		return
	}
	for index := range entry.OutputNames {
		entry.OutputNames[index] += entry.NameSuffix
	}
}
