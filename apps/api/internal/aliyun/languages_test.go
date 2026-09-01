package aliyun

import "testing"

func TestLanguageCatalogInvariants(t *testing.T) {
	if err := ValidateLanguageCatalogInvariants(); err != nil {
		t.Fatalf("language catalog invariants violated: %v", err)
	}
}

func TestLanguageCatalogLookups(t *testing.T) {
	for _, code := range []string{"zh", "en", "ja", "ko", "zh-tw", "yue", "ar", "ru", "id"} {
		if !IsValidGeneralLanguage(code) {
			t.Fatalf("expected %q to be a valid general language", code)
		}
	}
	for _, code := range []string{"auto", "", "english", "zh_cn", "vi-vn"} {
		if IsValidGeneralLanguage(code) {
			t.Fatalf("expected %q to be invalid", code)
		}
	}
}

func TestProfessionalSceneMatrix(t *testing.T) {
	allowed := [][3]string{
		{"finance", "zh", "en"},
		{"finance", "en", "zh"},
		{"medical", "zh", "ja"},
		{"medical", "ja", "zh"},
		{"social", "zh", "ko"},
		{"social", "ko", "zh"},
		{"title", "zh", "yue"},
		{"title", "en", "he"},
		{"title", "ja", "zh"},
		{"title", "zh-tw", "zh"},
		{"title", "ms", "en"},
		{"description", "en", "nl"},
		{"communication", "en", "vi"},
		{"communication", "vi", "en"},
		{"communication", "zh", "ar"},
		{"communication", "ar", "zh"},
	}
	for _, test := range allowed {
		if !SupportsProfessionalPair(test[0], test[1], test[2]) {
			t.Fatalf("expected %s %s->%s to be supported", test[0], test[1], test[2])
		}
	}
	// Directions that must not be derived from set membership.
	denied := [][3]string{
		{"finance", "zh", "ja"},
		{"medical", "en", "ja"},
		{"social", "ja", "en"},
		{"title", "yue", "zh"},
		{"title", "he", "en"},
		{"communication", "ar", "ru"},
		{"communication", "ru", "fr"},
		{"communication", "ms", "vi"},
		{"title", "zh", "de"},
		{"description", "pl", "en"},
		{"finance", "en", "ja"},
		{"medical", "ko", "zh"},
	}
	for _, test := range denied {
		if SupportsProfessionalPair(test[0], test[1], test[2]) {
			t.Fatalf("expected %s %s->%s to be rejected", test[0], test[1], test[2])
		}
	}
	for _, scene := range ProfessionalScenes {
		if !IsProfessionalScene(scene) {
			t.Fatalf("expected scene %q to be official", scene)
		}
	}
	if IsProfessionalScene("code") || IsProfessionalScene("") {
		t.Fatal("non-official scenes must be rejected")
	}
}
