# solo-company フォーク 開発ルール（正本）

1. 元の Claw Empire のファイル（README*、AGENTS.md、既存のモジュール）は、全体の書き換えをしない。差し込みは最小限にし、`[solo-company]` コメントを付ける。
2. 独自の機能は `server/custom/` にまとめる。元のリポジトリの更新を取り込みやすくするため。
3. セキュリティに関わる変更（server/custom/governance/**、safe-mode、承認、Docker 関連）は、CEOの承認と `pnpm test:security` の合格が必要。
4. テストを弱める変更（skip、期待値の緩和）をしない。
5. 秘密情報をコード・ログ・テストデータに書かない。テストにはダミーデータだけを使う。
6. 破壊的なgit操作（force push、reset --hard、ブランチの削除、履歴の書き換え）をしない。
7. ai-office の社内ルールは ai-office/docs/ が正本。ここには重複して書かない。
