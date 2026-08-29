package knowledge

import (
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	fragmentVersion = 1
	fragmentTarget  = 4 * 1024
	fragmentMaximum = 8 * 1024
)

var (
	markdownPrefix = regexp.MustCompile(`^(?:#{1,6}|>|[-+*])\s+`)
	markdownWrap   = strings.NewReplacer("**", "", "__", "", "~~", "", "`", "")
	fragmentNS     = uuid.MustParse("30272dc4-6069-55f1-9c15-885cb9ac5bd0")
)

type textFragment struct {
	ID         uuid.UUID
	Kind       string
	Ordinal    int
	StartByte  int
	EndByte    int
	Content    string
	Normalized string
}

func generatedTitle(body, sensitivity string, files []preparedFile, location *time.Location, now time.Time) string {
	if sensitivity != "normal" {
		return "敏感记录 · " + now.In(location).Format("01-02 15:04")
	}
	if strings.TrimSpace(body) != "" {
		for _, line := range strings.Split(body, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
				continue
			}
			line = markdownPrefix.ReplaceAllString(line, "")
			line = strings.TrimSpace(markdownWrap.Replace(line))
			if line != "" {
				return truncateTitle(line)
			}
		}
	}
	if len(files) == 1 && files[0].Kind == "file" {
		return truncateTitle(files[0].DisplayName)
	}
	if len(files) > 0 && allImages(files) {
		return "图片记录 · " + now.In(location).Format("01-02 15:04")
	}
	if len(files) > 0 {
		return truncateTitle(files[0].DisplayName)
	}
	return "新记录 · " + now.In(location).Format("01-02 15:04")
}

func truncateTitle(value string) string {
	runes := []rune(strings.TrimSpace(value))
	if len(runes) <= 200 {
		return string(runes)
	}
	return string(runes[:199]) + "…"
}

func normalizeSearch(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

type sourceRange struct {
	start int
	end   int
	kind  string
}

func splitTextFragments(rawRecordID uuid.UUID, body string) []textFragment {
	if body == "" {
		return nil
	}
	ranges := contentRanges(body)
	fragments := make([]textFragment, 0, len(ranges))
	for _, source := range ranges {
		for _, chunk := range splitRange(body, source) {
			content := body[chunk.start:chunk.end]
			if strings.TrimSpace(content) == "" {
				continue
			}
			ordinal := len(fragments)
			fragments = append(fragments, textFragment{
				ID:         uuid.NewSHA1(fragmentNS, []byte(rawRecordID.String()+":1:"+strconv.Itoa(ordinal))),
				Kind:       chunk.kind,
				Ordinal:    ordinal,
				StartByte:  chunk.start,
				EndByte:    chunk.end,
				Content:    content,
				Normalized: normalizeSearch(content),
			})
		}
	}
	return fragments
}

func contentRanges(body string) []sourceRange {
	var ranges []sourceRange
	blockStart := -1
	blockKind := "raw_text"
	inCode := false
	lineStart := 0
	for lineStart < len(body) {
		lineEnd := strings.IndexByte(body[lineStart:], '\n')
		if lineEnd < 0 {
			lineEnd = len(body)
		} else {
			lineEnd += lineStart + 1
		}
		line := strings.TrimSpace(body[lineStart:lineEnd])
		isFence := strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~")
		isHeading := !inCode && strings.HasPrefix(line, "#")
		if isFence {
			if !inCode {
				if blockStart >= 0 {
					ranges = append(ranges, sourceRange{start: blockStart, end: lineStart, kind: blockKind})
				}
				blockStart = lineStart
				blockKind = "code"
				inCode = true
			} else {
				ranges = append(ranges, sourceRange{start: blockStart, end: lineEnd, kind: "code"})
				blockStart = -1
				blockKind = "raw_text"
				inCode = false
			}
		} else if !inCode && (line == "" || isHeading) {
			if blockStart >= 0 {
				ranges = append(ranges, sourceRange{start: blockStart, end: lineStart, kind: blockKind})
				blockStart = -1
			}
			if isHeading {
				ranges = append(ranges, sourceRange{start: lineStart, end: lineEnd, kind: "raw_text"})
			}
		} else if blockStart < 0 {
			blockStart = lineStart
		}
		lineStart = lineEnd
	}
	if blockStart >= 0 {
		ranges = append(ranges, sourceRange{start: blockStart, end: len(body), kind: blockKind})
	}
	return mergeNormalRanges(body, ranges)
}

func mergeNormalRanges(body string, ranges []sourceRange) []sourceRange {
	merged := make([]sourceRange, 0, len(ranges))
	for _, current := range ranges {
		if len(merged) == 0 || current.kind == "code" || merged[len(merged)-1].kind == "code" {
			merged = append(merged, current)
			continue
		}
		previous := &merged[len(merged)-1]
		previousContent := strings.TrimSpace(body[previous.start:previous.end])
		headingBoundary := strings.HasPrefix(previousContent, "#") || strings.HasPrefix(strings.TrimSpace(body[current.start:current.end]), "#")
		if !headingBoundary && current.end-previous.start <= fragmentTarget {
			previous.end = current.end
			continue
		}
		merged = append(merged, current)
	}
	return merged
}

func splitRange(body string, source sourceRange) []sourceRange {
	var chunks []sourceRange
	for start := source.start; start < source.end; {
		remaining := source.end - start
		if remaining <= fragmentMaximum {
			chunks = append(chunks, sourceRange{start: start, end: source.end, kind: source.kind})
			break
		}
		limit := min(start+fragmentTarget, source.end)
		end := start + strings.LastIndexByte(body[start:limit], '\n') + 1
		if end <= start {
			end = utf8Boundary(body, min(start+fragmentMaximum, source.end))
		}
		chunks = append(chunks, sourceRange{start: start, end: end, kind: source.kind})
		start = end
	}
	return chunks
}

func utf8Boundary(value string, index int) int {
	for index > 0 && index < len(value) && !utf8.RuneStart(value[index]) {
		index--
	}
	return index
}

func allImages(files []preparedFile) bool {
	for _, file := range files {
		if file.Kind != "image" {
			return false
		}
	}
	return len(files) > 0
}

func validSensitivity(value string) bool {
	return value == "normal" || value == "sensitive" || value == "unknown"
}

func validContentFormat(value string) bool {
	return value == "plain_text" || value == "markdown"
}

func runeCount(value string) int {
	return len([]rune(value))
}

func stripControl(value string) string {
	return strings.Map(func(character rune) rune {
		if unicode.IsControl(character) {
			return -1
		}
		return character
	}, value)
}
