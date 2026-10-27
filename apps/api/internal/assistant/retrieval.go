package assistant

import (
	"context"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/ai"
)

// normalizeQuery mirrors the fact-layer normalization used by search_fragments
// so assistant retrieval matches the existing search semantics (docs/16 §9.4).
func normalizeQuery(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func escapeLikePattern(value string) string {
	escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(value)
	return "%" + escaped + "%"
}

type retrievalCandidate struct {
	FragmentID       uuid.UUID
	ItemID           uuid.UUID
	RawRecordID      *uuid.UUID
	ArtifactID       *uuid.UUID
	SourceKind       string
	Ordinal          int
	StartByte        *int
	EndByte          *int
	Title            string
	Content          string
	Sensitivity      string
	LexicalRank      *int
	VectorRank       *int
	LexicalClass     int
	LexicalSignal    float64
	CosineSimilarity float64
}

// hybridRetrieve runs the frozen hybrid-rrf-v1 retrieval (docs/16 §9.4):
// 24 lexical + 24 vector candidates behind hard thresholds, merged with RRF
// k=60, deduplicated, top 8. filename never participates and every candidate
// passes the real-time fact-layer gate from the single eligible_fragments CTE.
func hybridRetrieve(ctx context.Context, querier rowQuerier, generation int64, policy, rawQuery string, queryVector []float32) ([]retrievalCandidate, error) {
	normalized := normalizeQuery(rawQuery)
	if normalized == "" {
		return []retrievalCandidate{}, nil
	}
	lexical, err := lexicalCandidates(ctx, querier, policy, generation, normalized)
	if err != nil {
		return nil, err
	}
	vector, err := vectorCandidates(ctx, querier, policy, generation, queryVector)
	if err != nil {
		return nil, err
	}
	return fuseCandidates(lexical, vector), nil
}

// lexicalCandidates admits fragments hitting literal substring, tsvector or
// trigram >= 0.30, ranked by the frozen lexical_class/weight/signal order.
func lexicalCandidates(ctx context.Context, querier rowQuerier, policy string, generation int64, normalized string) ([]retrievalCandidate, error) {
	// Parameters: $1 policy, $2 generation, $3 normalized query, $4 LIKE pattern.
	query := eligibleFragmentsSource(policy, generation) + `, scored AS (
		SELECT eligible.*,
			CASE
				WHEN eligible.source_kind = 'title' AND eligible.normalized_content = $3 THEN 5
				WHEN eligible.source_kind IN ('raw_text', 'code')
				     AND (eligible.normalized_content LIKE $4 ESCAPE '\' OR eligible.search_vector @@ plainto_tsquery('simple'::regconfig, $3)) THEN 4
				WHEN eligible.source_kind IN ('title', 'metadata')
				     AND (eligible.normalized_content LIKE $4 ESCAPE '\' OR eligible.search_vector @@ plainto_tsquery('simple'::regconfig, $3)) THEN 3
				WHEN eligible.source_kind IN ('ai_text', 'image_text') THEN 1
				ELSE 2
			END AS lexical_class,
			CASE
				WHEN eligible.normalized_content LIKE $4 ESCAPE '\' OR eligible.search_vector @@ plainto_tsquery('simple'::regconfig, $3) THEN 1.0::real
				ELSE similarity(eligible.normalized_content, $3)
			END AS lexical_signal
		FROM eligible
		WHERE eligible.normalized_content LIKE $4 ESCAPE '\'
		   OR eligible.search_vector @@ plainto_tsquery('simple'::regconfig, $3)
		   OR similarity(eligible.normalized_content, $3) >= 0.30
	)
	SELECT id, item_id, raw_record_id, artifact_id, source_kind, ordinal, start_byte, end_byte,
	       title, content, sensitivity, lexical_class, lexical_signal
	FROM scored
	ORDER BY lexical_class DESC, weight DESC, lexical_signal DESC, id ASC
	LIMIT $5`
	rows, err := querier.Query(ctx, query, policy, generation, normalized, escapeLikePattern(normalized), LexicalCandidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make([]retrievalCandidate, 0)
	for rows.Next() {
		var candidate retrievalCandidate
		if err := rows.Scan(&candidate.FragmentID, &candidate.ItemID, &candidate.RawRecordID, &candidate.ArtifactID,
			&candidate.SourceKind, &candidate.Ordinal, &candidate.StartByte, &candidate.EndByte,
			&candidate.Title, &candidate.Content, &candidate.Sensitivity,
			&candidate.LexicalClass, &candidate.LexicalSignal); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

// vectorCandidates scans ready rows of the current generation with exact
// cosine, admitting similarity >= 0.50, ranked by the frozen order.
func vectorCandidates(ctx context.Context, querier rowQuerier, policy string, generation int64, queryVector []float32) ([]retrievalCandidate, error) {
	if queryVector == nil {
		return []retrievalCandidate{}, nil
	}
	// Parameters: $1 policy, $2 generation, $3 query vector.
	query := eligibleFragmentsSource(policy, generation) + `
		SELECT eligible.id, eligible.item_id, eligible.raw_record_id, eligible.artifact_id,
		       eligible.source_kind, eligible.ordinal, eligible.start_byte, eligible.end_byte,
		       eligible.title, eligible.content, eligible.sensitivity,
		       1 - (e.embedding <=> $3) AS cosine_similarity
		FROM eligible
		JOIN assistant_fragment_embeddings e ON e.fragment_id = eligible.id
		WHERE eligible.embedding_ready
		  AND 1 - (e.embedding <=> $3) >= 0.50
		ORDER BY cosine_similarity DESC, eligible.weight DESC, eligible.id ASC
		LIMIT $4`
	rows, err := querier.Query(ctx, query, policy, generation, vectorFor(queryVector), VectorCandidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make([]retrievalCandidate, 0)
	for rows.Next() {
		var candidate retrievalCandidate
		if err := rows.Scan(&candidate.FragmentID, &candidate.ItemID, &candidate.RawRecordID, &candidate.ArtifactID,
			&candidate.SourceKind, &candidate.Ordinal, &candidate.StartByte, &candidate.EndByte,
			&candidate.Title, &candidate.Content, &candidate.Sensitivity,
			&candidate.CosineSimilarity); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

// fuseCandidates applies Reciprocal Rank Fusion with the frozen k=60, dedupes
// fragments and returns at most 8 sources in the frozen final order.
func fuseCandidates(lexical, vector []retrievalCandidate) []retrievalCandidate {
	byID := make(map[uuid.UUID]*retrievalCandidate, len(lexical)+len(vector))
	order := make([]uuid.UUID, 0, len(lexical)+len(vector))
	addChannel := func(rows []retrievalCandidate, isLexical bool) {
		for index, row := range rows {
			rank := index + 1
			candidate, exists := byID[row.FragmentID]
			if !exists {
				copied := row
				candidate = &copied
				byID[row.FragmentID] = candidate
				order = append(order, row.FragmentID)
			}
			if isLexical {
				r := rank
				candidate.LexicalRank = &r
				candidate.LexicalClass = row.LexicalClass
				candidate.LexicalSignal = row.LexicalSignal
			} else {
				r := rank
				candidate.VectorRank = &r
				candidate.CosineSimilarity = row.CosineSimilarity
			}
		}
	}
	addChannel(lexical, true)
	addChannel(vector, false)

	type fused struct {
		candidate *retrievalCandidate
		score     float64
		channels  int
		bestRank  int
	}
	merged := make([]fused, 0, len(order))
	for _, id := range order {
		candidate := byID[id]
		entry := fused{candidate: candidate, bestRank: LexicalCandidates + VectorCandidates + 1}
		if candidate.LexicalRank != nil {
			entry.score += 1.0 / float64(RRFK+*candidate.LexicalRank)
			entry.channels++
			if *candidate.LexicalRank < entry.bestRank {
				entry.bestRank = *candidate.LexicalRank
			}
		}
		if candidate.VectorRank != nil {
			entry.score += 1.0 / float64(RRFK+*candidate.VectorRank)
			entry.channels++
			if *candidate.VectorRank < entry.bestRank {
				entry.bestRank = *candidate.VectorRank
			}
		}
		merged = append(merged, entry)
	}
	sort.SliceStable(merged, func(left, right int) bool {
		a, b := merged[left], merged[right]
		if a.score != b.score {
			return a.score > b.score
		}
		if a.channels != b.channels {
			return a.channels > b.channels
		}
		if a.bestRank != b.bestRank {
			return a.bestRank < b.bestRank
		}
		aLex, bLex := rankOrMax(a.candidate.LexicalRank), rankOrMax(b.candidate.LexicalRank)
		if aLex != bLex {
			return aLex < bLex
		}
		aVec, bVec := rankOrMax(a.candidate.VectorRank), rankOrMax(b.candidate.VectorRank)
		if aVec != bVec {
			return aVec < bVec
		}
		return a.candidate.FragmentID.String() < b.candidate.FragmentID.String()
	})
	if len(merged) > MaximumRunSources {
		merged = merged[:MaximumRunSources]
	}
	result := make([]retrievalCandidate, 0, len(merged))
	for _, entry := range merged {
		result = append(result, *entry.candidate)
	}
	return result
}

func rankOrMax(rank *int) int {
	if rank == nil {
		return 1 << 30
	}
	return *rank
}

// buildSourceSnapshots redacts and freezes the retrieved fragments. Redact
// policy applies to every outbound fragment even when the item's sensitivity
// label is normal: labels do not prove the text itself contains no secret.
// Titles and content share one redactor per source so the same secret found in
// both resolves to the same placeholder.
func buildSourceSnapshots(candidates []retrievalCandidate, policy string) []retrievalCandidate {
	snapshots := make([]retrievalCandidate, len(candidates))
	copy(snapshots, candidates)
	for index := range snapshots {
		if policy == "redact" {
			redactor := ai.NewTextRedactor()
			snapshots[index].Title = redactor.Redact(snapshots[index].Title)
			snapshots[index].Content = redactor.Redact(snapshots[index].Content)
		}
	}
	return snapshots
}
