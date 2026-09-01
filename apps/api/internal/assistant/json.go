package assistant

import "encoding/json"

func jsonUnmarshal(data []byte, target any) error {
	return json.Unmarshal(data, target)
}

func jsonMarshal(value any) ([]byte, error) {
	return json.Marshal(value)
}
