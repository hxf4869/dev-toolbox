package assistant

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

type conversationCursorPayload struct {
	View      string     `json:"v"`
	Folder    string     `json:"f,omitempty"`
	PinnedAt  *time.Time `json:"p"`
	UpdatedAt time.Time  `json:"u"`
	ID        uuid.UUID  `json:"i"`
}

func encodeConversationCursor(cursor listConversationsCursor, view, folder string) (string, error) {
	encoded, err := json.Marshal(conversationCursorPayload{
		View: view, Folder: folder, PinnedAt: cursor.PinnedAt, UpdatedAt: cursor.UpdatedAt, ID: cursor.ID,
	})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func decodeConversationCursor(raw, view, folder string) (*listConversationsCursor, error) {
	var payload conversationCursorPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	if payload.View != view || payload.Folder != folder || payload.ID == uuid.Nil || payload.UpdatedAt.IsZero() {
		return nil, errors.New("cursor mismatch")
	}
	return &listConversationsCursor{PinnedAt: payload.PinnedAt, UpdatedAt: payload.UpdatedAt, ID: payload.ID}, nil
}

type messagesCursorPayload struct {
	Sequence int64     `json:"s"`
	ID       uuid.UUID `json:"i"`
}

func encodeMessagesCursor(cursor messagesCursor) (string, error) {
	encoded, err := json.Marshal(messagesCursorPayload{Sequence: cursor.Sequence, ID: cursor.ID})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func decodeMessagesCursor(raw string) (*messagesCursor, error) {
	var payload messagesCursorPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	if payload.ID == uuid.Nil || payload.Sequence < 1 {
		return nil, errors.New("invalid cursor")
	}
	return &messagesCursor{Sequence: payload.Sequence, ID: payload.ID}, nil
}
