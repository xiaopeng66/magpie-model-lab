# 发布与 Magpie 插件发现

本指南依据 [Magpie 官方插件文档](https://usemagpie.ai/docs/plugins#publish) 和上游发现实现核对，查询日期为 **2026-11-14**。发现规则可能随宿主更新而变化。

## 推荐渠道

**先发布公开 GitHub 仓库并设置 `magpie-plugin` 主题。** 不需要先发布 npm，也不需要先获得社区 registry 合并，就能进入“插件 → 发现 → GitHub 非官方插件”。

| 渠道 | 条件 | Magpie 中的表现 |
| --- | --- | --- |
| GitHub 主题收录 | 公开、非 fork、未归档的仓库；topic 为 `magpie-plugin`；根目录有有效 `package.json`，声明的入口真实存在 | 在 GitHub 非官方区发现，可从仓库直接安装 |
| npm | 发布公开包，保留正确的 `repository` | 可按包名安装；GitHub 卡片确认 npm 仓库归属一致后，优先使用 npm 版本 |
| 社区 registry | 向 `magpie-community/plugins` 的 `registry.json` 提交条目并获合并 | 自有仓库的条目可被名称、简介或发布者搜索，不自动成为官方社区推荐 |

Magpie 的普通 npm 搜索当前主要筛选 OpenCode 供应商插件和 pi provider 包。仅增加 `magpie-plugin` **npm keyword** 不等于进入发现；GitHub **topic** 是另一个设置。本插件依赖 Magpie 页面与网关，保持真实分类，不添加无关的 OpenCode 登录插件标签。

## 1.0.5 正式更新

本次 GitHub 发布版本为 **1.0.5**，正式标签和 Release 为 `v1.0.5`，独立资产为 `magpie-pelican-bench-1.0.5.zip` 与 `.zip.sha256`。本次补齐可调生成超时，覆盖手动测试、指纹采样、自动参数、历史复测与趋势条件；默认 600 秒，0 为不设插件侧超时。历史正文按需读取，单批 JSON 导出采用 16 MiB 预算。发布前完成 Node 22、Node 26、Bun 测试及静态、打包检查；保留旧标签和资产，不覆盖已有版本。

## 1.0.3 历史更新

上一正式版本为 **1.0.3**。标签和 Release 为 `v1.0.3`，独立资产为 `magpie-pelican-bench-1.0.3.zip` 与校验文件。保留已有发布和本地试用包；重新打包时选择新的输出目录。后续发布递增版本，不覆盖旧标签或资产。

清单的中英文简介及 keywords 包含 AI 模型评测、模型对比、推理能力、智商／智力趣味测试、鹈鹕动画、模型指纹和定时监控。`magpie.summary` 每种语言均须保持在宿主允许的 300 UTF-8 字节以内，否则该语言简介会被忽略。发布同步 GitHub 仓库简介为 `模型实验室 Model Lab for Magpie：AI 模型评测与对比、糖果推理和智商趣味测试、鹈鹕动画、模型指纹、定时自动测试。`，并增加 `model-evaluation`、`model-comparison`、`reasoning-benchmark`、`iq-style-test` 等主题。检索仍受 GitHub 索引和宿主缓存影响。

## 1.0.0 首次发布信息

- 展示名称：**模型实验室 · Model Lab**。
- 版本：**1.0.0**。
- 包名：`magpie-pelican-bench`，保留以兼容已有安装与数据。
- 仓库：[xiaopeng66/magpie-model-lab](https://github.com/xiaopeng66/magpie-model-lab)。
- GitHub 简介：`模型实验室 Model Lab for Magpie：鹈鹕动画、模型指纹、糖果推理与按模型自动测试。`
- topics：`magpie-plugin`、`magpie`、`model-lab`、`llm`、`benchmark`。
- 标签：`v1.0.0`；Release 标题：`模型实验室 Model Lab 1.0.0`。
- Release 正文使用 [更新记录](../CHANGELOG.md)，首页介绍使用 [README](../README.md)。

仓库地址已写入包的 `repository`、`homepage` 和 `bugs`。发布渠道为 GitHub，npm 暂未上线。`magpie.icon` 内嵌现有 PNG 图标，发现卡片不依赖外部图片地址。维护分支或自行分发时，请同步仓库字段和安装示例后重新打包。

## 文件准备与检查

公开源码目录应包含：

```text
package.json  index.mjs  serve.mjs
lib/  page/  ui/  vendor/
docs/usage.md  docs/favorites-guide.md  docs/publishing.md
tools/  tests/
README.md  CHANGELOG.md  LICENSE  THIRD_PARTY_NOTICES.md  .gitignore
```

`index.mjs` 和页面文件可直接加载，无需构建；Magpie 安装时不运行依赖的安装脚本，不能依赖 `postinstall` 临时生成入口。

开发工作目录还保留内部设计与验证材料。发布时使用白名单生成的 ZIP 解压目录作为 Git 仓库来源，避免直接把整个开发目录推上网。安装包不含运行数据、自动计划、参考库缓存、烟雾测试结果或内部验证报告。npm 包只包含运行文件与公开文档；ZIP 另含开发工具及测试。

以下命令检查 1.0.5 并生成发布包，不执行安装或发布：

```powershell
node --test tests/*.test.mjs
bun test ./tests
bun tools/check-static.mjs
npm pack --dry-run --json
powershell -NoProfile -File tools/package.ps1 -OutputDirectory dist/release-1.0.5
powershell -NoProfile -File tools/check-package.ps1 -Archive dist/release-1.0.5/magpie-pelican-bench-1.0.5.zip
npm pack --pack-destination dist --ignore-scripts
```

打包先写唯一临时 ZIP，逐文件核验成功后才生成最终文件名；失败不留下半包，补齐文件后可在同一目录重试。脚本拒绝覆盖已经存在的同名 ZIP；需要再次构建时通过 `-OutputDirectory` 指定新目录。核对 `.zip.sha256` 和 npm 包实际文件清单后再发布。

## GitHub 首次发布步骤（1.0.0 历史记录）

以下为首次发布时使用的流程，现有仓库无需重新创建。后续更新提交新源码并递增标签和 Release 版本，不重跑旧版本发布命令：

```powershell
git init -b main
git add .
git commit -m "Release Model Lab 1.0.0"
gh repo create xiaopeng66/magpie-model-lab --public --source . --remote origin --push --description '模型实验室 Model Lab for Magpie：鹈鹕动画、模型指纹、糖果推理与按模型自动测试。'
gh repo edit xiaopeng66/magpie-model-lab --add-topic magpie-plugin --add-topic magpie --add-topic model-lab --add-topic llm --add-topic benchmark
git tag v1.0.0
git push origin v1.0.0
gh release create v1.0.0 --repo xiaopeng66/magpie-model-lab --verify-tag --title '模型实验室 Model Lab 1.0.0' --notes-file CHANGELOG.md
```

随后在该 Release 上传验证后的 `magpie-pelican-bench-1.0.0.zip` 和 `.zip.sha256`。GitHub 自带源码压缩包也可安装，但独立 ZIP 直接包含插件根目录，便于本地添加。

用户可以使用 `magpie plugin add github:xiaopeng66/magpie-model-lab` 安装默认分支，或附加 `#v1.0.5` 固定本次正式版。后续发布保留同一仓库和包名，并递增版本。

## 验证发现

1. 确认 GitHub 仓库为 public、不是 fork、没有归档，topics 中确实包含 `magpie-plugin`。
2. 确认默认分支根目录存在 `package.json`，其中 `main` 指向仓库内的 `index.mjs`，页面和依赖文件均已提交。
3. 在 GitHub 搜索 `topic:magpie-plugin user:xiaopeng66`，确认仓库被 GitHub 索引。
4. 在 Magpie“插件 → 发现”的 GitHub 非官方区查找 `magpie-model-lab` 或发布者 `xiaopeng66`，查看图标、简介及版本。
5. 在隔离的 Magpie 配置环境中实际安装，打开页面并确认版本，再验收发现卡片的安装按钮。

上游源码将 GitHub 发现缓存设置为 **10 分钟**；新仓库还受 GitHub 索引、网络与 raw 文件缓存影响，因此不是添加 topic 后立刻显示的保证。发现功能被关闭、GitHub 访问失败或版本过旧时，也可能暂时看不到。无需为了触发收录反复改名或发版本。

Magpie 自有社区栏目与 GitHub 非官方栏目不同；加 topic 不代表官方背书或安全审核。

## npm 与社区搜索（可选）

如需增加 npm 渠道，先用有发布权限的 npm 账号登录并确认包名可用。包名查询时不存在，不代表名称已被预留。下面仅为 1.0.5 的可选 npm 发布示例；本次只发布 GitHub，不执行这些命令。

```powershell
npm login --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm publish ./dist/magpie-pelican-bench-1.0.5.tgz --access public --registry https://registry.npmjs.org
```

发布已检查的 `.tgz`，可确保上传的正是检查过的文件。npm 同名同版本不能覆盖重发；需要修正时发布新版本。登录、双重验证与包名权限以 npm 实际提示为准。

npm 上线后，如希望进一步通过社区 registry 搜索，可向 [registry.json](https://github.com/magpie-community/plugins/blob/main/registry.json) 提交下列条目。合并由维护者决定，且有最长约 6 小时的宿主列表缓存：

```json
{
  "package": "magpie-pelican-bench",
  "name": "Model Lab · 模型实验室",
  "kind": "page",
  "icon": "https://raw.githubusercontent.com/xiaopeng66/magpie-model-lab/main/page/icon.png",
  "summary": {
    "en": "Compare AI models with reasoning puzzles, IQ-style fun tests, HTML animations and model fingerprints, with scheduled monitoring. Puzzle results are not formal IQ scores.",
    "zh": "AI 模型能力评测与对比：糖果推理、智商趣味测试、鹈鹕动画和模型指纹；支持定时自动测试。趣味结果不等同于正式智商评分。"
  }
}
```

自有仓库条目省略 `community`，不要标成 `true`。本项目通过 GitHub topic 发现；registry 收录需另行提交 PR 并由维护者审核。

## 依据

- [Magpie：Publishing and listing](https://usemagpie.ai/docs/plugins#publish)
- [GitHub topic 发现、10 分钟缓存及入口检查](https://github.com/yetone/magpie/blob/27c998aba0a730be431aa8addb5f2c9bba6869eb/internal/plugin/github.go)
- [npm 搜索、元数据与 registry 规则](https://github.com/yetone/magpie/blob/27c998aba0a730be431aa8addb5f2c9bba6869eb/internal/plugin/market.go)
- [Magpie 社区插件仓库](https://github.com/magpie-community/plugins)
