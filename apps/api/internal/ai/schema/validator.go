package schema

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"

	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

const schemaResource = "https://dev-toolbox.local/schemas/ai-artifact-1.0.json"

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type Validator struct {
	schema *jsonschema.Schema
}

func New(rawSchema []byte) (*Validator, error) {
	decoder := json.NewDecoder(bytes.NewReader(rawSchema))
	decoder.UseNumber()
	var schemaDocument any
	if err := decoder.Decode(&schemaDocument); err != nil {
		return nil, fmt.Errorf("decode artifact schema: %w", err)
	}
	if err := ensureEOF(decoder); err != nil {
		return nil, fmt.Errorf("decode artifact schema: %w", err)
	}

	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	compiler.RegisterFormat(&jsonschema.Format{
		Name: "uuid",
		Validate: func(value any) error {
			text, ok := value.(string)
			if !ok || uuidPattern.MatchString(text) {
				return nil
			}
			return fmt.Errorf("must be a UUID")
		},
	})
	if err := compiler.AddResource(schemaResource, schemaDocument); err != nil {
		return nil, fmt.Errorf("add artifact schema: %w", err)
	}
	compiled, err := compiler.Compile(schemaResource)
	if err != nil {
		return nil, fmt.Errorf("compile artifact schema: %w", err)
	}
	return &Validator{schema: compiled}, nil
}

func (validator *Validator) ValidateJSON(document []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("decode artifact: %w", err)
	}
	if err := ensureEOF(decoder); err != nil {
		return err
	}
	if err := validator.schema.Validate(value); err != nil {
		return fmt.Errorf("validate artifact: %w", err)
	}
	return nil
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("artifact contains more than one JSON value")
		}
		return fmt.Errorf("decode artifact trailer: %w", err)
	}
	return nil
}
