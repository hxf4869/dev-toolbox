package aliyun

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
)

//go:embed translation_languages.v1.json
var translationLanguagesFS embed.FS

// LanguageListVersion is frozen from docs/11 §2.1.1 (aliyun-language-list-2026-08-31).
const LanguageListVersion = "aliyun-language-list-2026-08-31"

// ProfessionalScenes are the six official alimt professional scenes.
var ProfessionalScenes = []string{"title", "description", "communication", "medical", "social", "finance"}

type languageList struct {
	Version                  string                 `json:"version"`
	GeneralLanguages         []generalLanguage      `json:"generalLanguages"`
	ProfessionalPairsByScene map[string][][2]string `json:"professionalPairsByScene"`
}

type generalLanguage struct {
	Code   string `json:"code"`
	NameZh string `json:"nameZh"`
	NameEn string `json:"nameEn"`
}

type languageCatalog struct {
	document languageList
	raw      []byte
	codes    map[string]struct{}
	pairs    map[string]map[[2]string]struct{}
}

var catalog = mustLoadLanguageCatalog()

func mustLoadLanguageCatalog() *languageCatalog {
	raw, err := translationLanguagesFS.ReadFile("translation_languages.v1.json")
	if err != nil {
		panic(fmt.Sprintf("aliyun: embedded language list unreadable: %v", err))
	}
	var document languageList
	if err := json.Unmarshal(raw, &document); err != nil {
		panic(fmt.Sprintf("aliyun: embedded language list invalid: %v", err))
	}
	c := &languageCatalog{
		document: document,
		raw:      raw,
		codes:    make(map[string]struct{}, len(document.GeneralLanguages)),
		pairs:    make(map[string]map[[2]string]struct{}, len(document.ProfessionalPairsByScene)),
	}
	for _, language := range document.GeneralLanguages {
		c.codes[language.Code] = struct{}{}
	}
	for scene, pairs := range document.ProfessionalPairsByScene {
		set := make(map[[2]string]struct{}, len(pairs))
		for _, pair := range pairs {
			set[[2]string{pair[0], pair[1]}] = struct{}{}
		}
		c.pairs[scene] = set
	}
	return c
}

// IsValidGeneralLanguage reports whether the code is in the frozen 214-entry list.
func IsValidGeneralLanguage(code string) bool {
	_, ok := catalog.codes[code]
	return ok
}

// IsProfessionalScene reports whether the scene is one of the six official values.
func IsProfessionalScene(scene string) bool {
	_, ok := catalog.pairs[scene]
	return ok
}

// SupportsProfessionalPair reports whether the directed pair belongs to the scene matrix.
func SupportsProfessionalPair(scene, source, target string) bool {
	set, ok := catalog.pairs[scene]
	if !ok {
		return false
	}
	_, supported := set[[2]string{source, target}]
	return supported
}

// RawLanguageList returns the embedded document bytes for the read-only language API.
func RawLanguageList() []byte {
	return catalog.raw
}

// ErrLanguageListCorrupted guards the frozen invariants at load time.
var ErrLanguageListCorrupted = errors.New("aliyun language list invariant violated")

// ValidateLanguageCatalogInvariants is used by tests to freeze docs/11 §2.1.1.
func ValidateLanguageCatalogInvariants() error {
	if catalog.document.Version != LanguageListVersion {
		return fmt.Errorf("%w: version %q", ErrLanguageListCorrupted, catalog.document.Version)
	}
	if len(catalog.document.GeneralLanguages) != 214 || len(catalog.codes) != len(catalog.document.GeneralLanguages) {
		return fmt.Errorf("%w: expected 214 unique codes, got %d entries / %d unique",
			ErrLanguageListCorrupted, len(catalog.document.GeneralLanguages), len(catalog.codes))
	}
	for _, language := range catalog.document.GeneralLanguages {
		if language.Code == "" || language.NameZh == "" || language.NameEn == "" {
			return fmt.Errorf("%w: empty field in %q", ErrLanguageListCorrupted, language.Code)
		}
	}
	for _, code := range []string{"zh", "en", "ja", "ko", "zh-tw", "yue"} {
		if _, ok := catalog.codes[code]; !ok {
			return fmt.Errorf("%w: required code %q missing", ErrLanguageListCorrupted, code)
		}
	}
	expectedCounts := map[string]int{
		"finance": 2, "medical": 4, "social": 6,
		"title": 34, "description": 34, "communication": 38,
	}
	if len(catalog.pairs) != len(expectedCounts) {
		return fmt.Errorf("%w: scene count %d", ErrLanguageListCorrupted, len(catalog.pairs))
	}
	for scene, count := range expectedCounts {
		set, ok := catalog.pairs[scene]
		if !ok {
			return fmt.Errorf("%w: scene %q missing", ErrLanguageListCorrupted, scene)
		}
		if len(set) != count {
			return fmt.Errorf("%w: scene %q has %d pairs, want %d", ErrLanguageListCorrupted, scene, len(set), count)
		}
		for pair := range set {
			if _, ok := catalog.codes[pair[0]]; !ok {
				return fmt.Errorf("%w: pair code %q outside general list", ErrLanguageListCorrupted, pair[0])
			}
			if _, ok := catalog.codes[pair[1]]; !ok {
				return fmt.Errorf("%w: pair code %q outside general list", ErrLanguageListCorrupted, pair[1])
			}
		}
	}
	return nil
}
