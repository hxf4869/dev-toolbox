package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/auth"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/knowledge"
	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/config"
)

func main() {
	if len(os.Args) < 3 || (os.Args[1] != "admin" && os.Args[1] != "maintenance") {
		usage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	cfg, err := config.LoadMigration()
	if err != nil {
		fail("配置无效")
	}
	database, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fail("数据库连接失败")
	}
	defer database.Close()

	if os.Args[1] == "admin" {
		switch os.Args[2] {
		case "init-owner":
			runInitOwner(ctx, database, os.Args[3:])
		case "reset-auth":
			runResetAuth(ctx, database, os.Args[3:])
		default:
			usage()
			os.Exit(2)
		}
		return
	}
	switch os.Args[2] {
	case "rebuild-search":
		runRebuildSearch(ctx, database, os.Args[3:])
	default:
		usage()
		os.Exit(2)
	}
}

func runInitOwner(ctx context.Context, database *pgxpool.Pool, arguments []string) {
	flags := flag.NewFlagSet("init-owner", flag.ExitOnError)
	username := flags.String("username", "owner", "登录账号")
	passwordFile := flags.String("password-file", "", "受保护的密码文件")
	_ = flags.Parse(arguments)
	password, err := readAndConfirmPassword(*passwordFile)
	if err != nil {
		fail(err.Error())
	}
	if err := auth.InitializeOwner(ctx, database, *username, password, time.Now()); err != nil {
		if errors.Is(err, auth.ErrOwnerExists) {
			fail("所有者已经存在，未执行覆盖")
		}
		fail("初始化所有者失败")
	}
	fmt.Println("所有者已创建；首次登录必须绑定 TOTP")
}

func runResetAuth(ctx context.Context, database *pgxpool.Pool, arguments []string) {
	flags := flag.NewFlagSet("reset-auth", flag.ExitOnError)
	passwordFile := flags.String("password-file", "", "受保护的密码文件")
	_ = flags.Parse(arguments)
	password, err := readAndConfirmPassword(*passwordFile)
	if err != nil {
		fail(err.Error())
	}
	if err := auth.ResetAuth(ctx, database, password, time.Now()); err != nil {
		if errors.Is(err, auth.ErrOwnerNotFound) {
			fail("实例尚未初始化所有者")
		}
		fail("认证重置失败")
	}
	fmt.Println("认证已重置；知识记录未修改，下次登录必须重新绑定 TOTP")
}

func runRebuildSearch(ctx context.Context, database *pgxpool.Pool, arguments []string) {
	flags := flag.NewFlagSet("rebuild-search", flag.ExitOnError)
	_ = flags.Parse(arguments)
	if flags.NArg() != 0 {
		usage()
		os.Exit(2)
	}
	result, err := knowledge.RebuildSearch(ctx, database, time.Now())
	if err != nil {
		fail("搜索索引重建失败")
	}
	fmt.Printf("搜索索引重建完成：%d 条记录，%d 个原始记录，%d 个当前片段\n", result.Items, result.RawRecords, result.Fragments)
}

func readAndConfirmPassword(path string) (string, error) {
	if path != "" {
		content, err := os.ReadFile(path)
		if err != nil {
			return "", errors.New("无法读取密码文件")
		}
		return trimOneLineEnding(string(content)), nil
	}
	reader := bufio.NewReader(os.Stdin)
	fmt.Fprint(os.Stderr, "新密码（输入不会进入日志）: ")
	password, err := reader.ReadString('\n')
	if err != nil {
		return "", errors.New("读取密码失败")
	}
	fmt.Fprint(os.Stderr, "再次输入新密码: ")
	confirmation, err := reader.ReadString('\n')
	if err != nil {
		return "", errors.New("读取确认密码失败")
	}
	password = trimOneLineEnding(password)
	confirmation = trimOneLineEnding(confirmation)
	if password != confirmation {
		return "", errors.New("两次输入的密码不一致")
	}
	return password, nil
}

func trimOneLineEnding(value string) string {
	value = strings.TrimSuffix(value, "\n")
	return strings.TrimSuffix(value, "\r")
}

func usage() {
	fmt.Fprintln(os.Stderr, "用法: dev-toolbox admin init-owner|reset-auth [--password-file PATH]")
	fmt.Fprintln(os.Stderr, "      dev-toolbox maintenance rebuild-search")
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
