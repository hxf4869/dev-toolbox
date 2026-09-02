// assistant-eval is a local acceptance tool, not a server endpoint or Worker lane.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/assistant"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/config"
)

func main() {
	if err := execute(os.Args[1:]); err != nil {
		// Errors are deliberately fixed messages, never HTTP/SQL bodies or file contents.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func execute(args []string) error {
	if len(args) == 0 || (args[0] != "validate" && args[0] != "run" && args[0] != "score") {
		return errors.New("用法: assistant-eval validate|run|score --cases PATH [--report PATH]；run 还需 --origin --model-id --auth-file --allow-provider-calls")
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	casesPath := flags.String("cases", "", "私有题集路径")
	schemaPath := flags.String("schema", "../../docs/contracts/assistant-evaluation.schema.json", "输入 Schema")
	reportPath := flags.String("report", "", "私有报告路径")
	origin := flags.String("origin", "", "应用 origin")
	fixtureAPI := flags.String("fixture-api", "", "仅合成四容器 fixture 的内部 gateway 地址")
	modelID := flags.String("model-id", "", "固定模型 ID")
	reasoning := flags.String("reasoning", "off", "固定思考档位")
	authPath := flags.String("auth-file", "", "私有 username/password/totpCode JSON")
	allowCalls := flags.Bool("allow-provider-calls", false, "当次调用已取得用户授权")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 || *casesPath == "" {
		return errors.New("命令参数无效")
	}
	input, err := readDataset(*casesPath, *schemaPath)
	if err != nil {
		return err
	}
	if args[0] == "validate" {
		fmt.Printf("题集有效：%s，40 题，分布 12/10/6/6/6；未调用 Provider\n", input.Kind)
		return nil
	}
	if *reportPath == "" {
		return errors.New("必须显式指定本地报告路径")
	}
	if args[0] == "score" {
		var output report
		raw, err := os.ReadFile(*reportPath)
		if err != nil || json.Unmarshal(raw, &output) != nil {
			return errors.New("无法读取报告")
		}
		summary, err := scoreReport(input, output)
		if err != nil {
			return err
		}
		_ = json.NewEncoder(os.Stdout).Encode(summary)
		if !summary.ThresholdsMet {
			return errors.New("尚未达到评测门槛或人工评分未完成")
		}
		return nil
	}
	if !*allowCalls {
		return errors.New("run 会外发 40 次回答及必要的改写/Embedding/标题/摘要请求；需当次授权后加 --allow-provider-calls")
	}
	parsed, err := url.Parse(*origin)
	if err != nil || parsed.User != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") || (parsed.Scheme != "https" && !(parsed.Scheme == "http" &&
		(parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"))) {
		return errors.New("origin 必须为 HTTPS origin；HTTP 仅允许本机回环地址")
	}
	id, err := uuid.Parse(*modelID)
	if err != nil || id == uuid.Nil {
		return errors.New("model-id 必须是已配置的模型 UUID")
	}
	if !strings.Contains("|off|minimal|low|medium|high|xhigh|max|", "|"+*reasoning+"|") {
		return errors.New("思考档位无效")
	}
	if !filepath.IsAbs(*reportPath) {
		return errors.New("run 的报告必须使用仓库外的绝对路径")
	}
	for directory := filepath.Dir(*reportPath); ; directory = filepath.Dir(directory) {
		if _, err := os.Stat(filepath.Join(directory, ".git")); err == nil {
			return errors.New("私有报告不能写入 Git 工作区")
		}
		if filepath.Dir(directory) == directory {
			break
		}
	}
	endpoint := strings.TrimRight(*origin, "/")
	if *fixtureAPI != "" {
		if input.Kind != "synthetic" || *fixtureAPI != "http://gateway" {
			return errors.New("fixture-api 仅用于合成隔离环境")
		}
		endpoint = *fixtureAPI
	}
	// Refuse overwrites before any external call. The caller owns this one private file.
	file, err := os.OpenFile(*reportPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("无法新建私有报告（不会覆盖已有文件）")
	}
	defer file.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	dsn, err := config.LoadDatabaseURL()
	if err != nil {
		return errors.New("评测需要显式数据库只读连接配置")
	}
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return errors.New("评测数据库连接失败")
	}
	defer db.Close()
	client := &evaluationClient{origin: strings.TrimRight(*origin, "/"), endpoint: endpoint, http: &http.Client{
		Timeout:       11 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	if err := client.login(ctx, *authPath); err != nil {
		return err
	}
	output := report{Version: 1, Kind: input.Kind, Results: []result{}}
	conversations := map[string]uuid.UUID{}
	for _, q := range input.Questions {
		var conversation *uuid.UUID
		if q.FollowUpTo != nil {
			parent := conversations[*q.FollowUpTo]
			conversation = &parent
		}
		content := q.Content
		if q.NoteOnly {
			content = "请仅根据笔记回答。\n" + content
		}
		var started assistant.RunStartResponseDTO
		if err := client.json(ctx, http.MethodPost, "/api/v1/assistant/runs", map[string]any{
			"clientRequestId": uuid.New(), "conversationId": conversation, "folderId": nil,
			"content": content, "modelId": id, "reasoning": *reasoning,
		}, &started); err != nil {
			return err
		}
		conversations[q.ID] = started.Run.ConversationID
		if err := client.wait(ctx, started.Run.ID); err != nil {
			return err
		}
		r := result{QuestionID: q.ID, Question: q.Content, Sources: []source{}}
		if err := client.json(ctx, http.MethodGet, "/api/v1/assistant/runs/"+started.Run.ID.String(), nil, &r.Run); err != nil {
			return err
		}
		if err := readEvidence(ctx, db, &r); err != nil {
			return err
		}
		r.Automatic = checkResult(q, r)
		output.Results = append(output.Results, r)
		// Persist progress to the same explicitly created private file, not to logs.
		if _, err := file.Seek(0, 0); err != nil {
			return errors.New("报告写入失败")
		}
		if err := file.Truncate(0); err != nil {
			return errors.New("报告写入失败")
		}
		encoder := json.NewEncoder(file)
		encoder.SetIndent("", "  ")
		if encoder.Encode(output) != nil || file.Sync() != nil {
			return errors.New("报告写入失败")
		}
		fmt.Printf("已完成 %d/40\n", len(output.Results))
		if r.Run.Status != "succeeded" {
			return errors.New("本轮运行未成功，已保留结果；未自动重试或继续外发")
		}
	}
	fmt.Println("40 题结果已写入私有报告；请填写 human.accepted 与失败分类后执行 score")
	return nil
}

type evaluationClient struct {
	origin, endpoint, cookie, csrf string
	http                           *http.Client
}

func (c *evaluationClient) request(ctx context.Context, method, path string, payload any) (*http.Response, error) {
	var body io.Reader
	if payload != nil {
		raw, _ := json.Marshal(payload)
		body = bytes.NewReader(raw)
	}
	endpoint := c.endpoint
	if endpoint == "" {
		endpoint = c.origin
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint+path, body)
	if err != nil {
		return nil, errors.New("评测请求创建失败")
	}
	req.Header.Set("Origin", c.origin)
	if c.endpoint != "" && c.endpoint != c.origin {
		origin, _ := url.Parse(c.origin)
		req.Host = origin.Host
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", c.cookie)
	req.Header.Set("X-CSRF-Token", c.csrf)
	response, err := c.http.Do(req)
	if err != nil {
		return nil, errors.New("评测 HTTP 请求失败；不输出敏感请求信息")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return nil, fmt.Errorf("评测 HTTP 状态 %d；已停止，不自动重试", response.StatusCode)
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == "__Host-dev-toolbox-session" {
			c.cookie = cookie.Name + "=" + cookie.Value
		}
	}
	return response, nil
}

func (c *evaluationClient) json(ctx context.Context, method, path string, payload, output any) error {
	response, err := c.request(ctx, method, path, payload)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if json.NewDecoder(response.Body).Decode(output) != nil {
		return errors.New("评测 API 响应无效")
	}
	return nil
}

func (c *evaluationClient) login(ctx context.Context, path string) error {
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
		TOTP     string `json:"totpCode"`
	}
	raw, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(raw, &credentials) != nil {
		return errors.New("无法读取私有登录文件")
	}
	var challenge struct {
		Status string `json:"status"`
		ID     string `json:"challengeId"`
	}
	if err := c.json(ctx, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": credentials.Username, "password": credentials.Password,
	}, &challenge); err != nil {
		return err
	}
	if challenge.Status != "mfa_required" {
		return errors.New("请先在应用中完成初次 MFA 设置")
	}
	var session struct {
		CSRF string `json:"csrfToken"`
	}
	if err := c.json(ctx, http.MethodPost, "/api/v1/auth/mfa/verify", map[string]any{
		"challengeId": challenge.ID, "method": "totp", "code": credentials.TOTP, "trustDevice": false, "deviceName": "",
	}, &session); err != nil {
		return err
	}
	c.csrf = session.CSRF
	if c.cookie == "" || c.csrf == "" {
		return errors.New("登录没有返回有效会话")
	}
	return nil
}

func (c *evaluationClient) wait(ctx context.Context, id uuid.UUID) error {
	response, err := c.request(ctx, http.MethodGet, "/api/v1/assistant/runs/"+id.String()+"/events", nil)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	event := ""
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			event = strings.TrimPrefix(line, "event: ")
		}
		if strings.HasPrefix(line, "data: ") {
			if event == "run.completed" || event == "run.failed" || event == "run.stopped" {
				return nil
			}
			if event == "snapshot" {
				var snapshot struct {
					Run assistant.AssistantRunDTO `json:"run"`
				}
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &snapshot) != nil {
					return errors.New("SSE snapshot 无效")
				}
				if snapshot.Run.Status == "succeeded" || snapshot.Run.Status == "failed" || snapshot.Run.Status == "stopped" {
					return nil
				}
			}
		}
	}
	return errors.New("SSE 在终态前断开；运行可能仍在继续，请检查报告和会话，不自动重发")
}

func readEvidence(ctx context.Context, db *pgxpool.Pool, r *result) error {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return errors.New("无法开启评测只读事务")
	}
	defer tx.Rollback(ctx)
	if tx.QueryRow(ctx, `SELECT r.knowledge_generation, m.content
		FROM assistant_runs r JOIN assistant_messages m ON m.id=r.output_message_id
		WHERE r.id=$1 AND m.current_run_id=r.id`, r.Run.ID).Scan(&r.KnowledgeGeneration, &r.Answer) != nil {
		return errors.New("无法读取本轮运行证据，或运行已被重试替代")
	}
	rows, err := tx.Query(ctx, `SELECT ordinal, fragment_id::text, cited_number, title_snapshot, excerpt_snapshot
		FROM assistant_run_sources WHERE run_id=$1 ORDER BY ordinal`, r.Run.ID)
	if err != nil {
		return errors.New("无法读取本轮来源")
	}
	defer rows.Close()
	for rows.Next() {
		var s source
		if rows.Scan(&s.Ordinal, &s.FragmentID, &s.CitationNumber, &s.Title, &s.Excerpt) != nil {
			return errors.New("本轮来源记录无效")
		}
		r.Sources = append(r.Sources, s)
	}
	if rows.Err() != nil || tx.Commit(ctx) != nil {
		return errors.New("读取本轮来源失败")
	}
	return nil
}
