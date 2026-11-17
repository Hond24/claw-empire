# solo-company フォーク 開発ルール（正本）

> このファイルは、CLAUDE.md から読み込まれる開発ルールの**正本**です（CLAUDE.md は元の .gitignore で管理対象外のため、各PCに置くだけのファイルにしています）。
> AI社員の作業範囲（ai-office）の外にあるので、AI社員は閲覧も編集もできません。変更はCEOの承認が必要です。
> 各PCで正しいルールが読み込まれていることは、`setup/preflight.mjs` で2段階に確認します：①CLAUDE.md が雛形（docs/solo-company/CLAUDE.md.template）と一致すること ②`--live-check` で、Claude に下のルール識別子を答えさせること。

ルール識別子：`SOLO-DEV-RULES-v1`

1. 元の Claw Empire のファイル（README*、AGENTS.md、既存のモジュール）は、全体の書き換えをしない。差し込みは最小限にし、`[solo-company]` コメントを付ける。
2. 独自の機能は `server/custom/` にまとめる。元のリポジトリの更新を取り込みやすくするため。
3. セキュリティに関わる変更（server/custom/governance/**、safe-mode、承認、Docker 関連）は、CEOの承認と `pnpm test:security` の合格が必要。
4. テストを弱める変更（skip、期待値の緩和）をしない。
5. 秘密情報をコード・ログ・テストデータに書かない。テストにはダミーデータだけを使う。
6. 破壊的なgit操作（force push、reset --hard、ブランチの削除、履歴の書き換え）をしない。
7. ai-office の社内ルールは ai-office/docs/ が正本。ここには重複して書かない。
8. コンテナ内でのコードの実行は、現時点では全社員に禁止。将来許可する場合も、エンジニアAIに限り、隔離、最小権限、ネットワーク制限、実行時間・メモリ・費用の上限を必須とする（ai-office 00_PLAN §8）。
