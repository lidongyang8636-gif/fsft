# 设备端高危 MCP 工具清单（DSH 侧执行纪律）

**位置：`%MAIN_REPO%-dsh\docs\设备端高危MCP工具清单.md`（本工作区，可写）**
**性质：纪律约定，不是技术护栏。生效范围 = DSH 会话里的我。**

---

## 0. 这份清单解决什么问题

Codex 侧有**逐工具审批**：`%USERPROFILE%\.codex\config.toml` 里可以写

```toml
[mcp_servers.vivado.tools.run_tcl]
approval_mode = "approve"
```

写了这行的工具，每次调用都弹窗要人点。**DSH 侧没有这个能力**——
`@deepseek-ai/dsh-mcp-client` 的配置只认 `serverName` / `transport` / `command` /
`args` / `env`，**没有任何审批字段**。DSH 的 `ask` 审批管的是文件沙箱写越界，
跟 MCP 工具调用是两套互不相干的机制：

| | Codex | DSH 现状 |
| --- | --- | --- |
| MCP 逐工具审批 | ✅ `config.toml` 逐条标 | ❌ 无 |
| 文件沙箱 | `sandbox_mode` + `writable_roots` | ✅ `workspace-write` |
| 命令审批 | `approval_policy = "on-request"` | ✅ `ask` |
| MCP 子进程 | 受沙箱约束 | **在沙箱之外，管不到** |

最后一行是真正的风险点：**MCP 子进程运行在 pwsh 沙箱之外**，不受 AGENTS.md
第 3 节那些写入限制约束。而 `vivado` / `fpga-mcp` 都挂着"任意 TCL / 任意后端命令"
这类能间接写盘的逃生舱口。

所以本清单是**用纪律替代护栏**：既然环境拦不住，就约定"先问后调"。
与 `AGENTS.md` **§3 红线 5–9**（设备端安全边界）同属一个思路——**环境兜不住的地方，用纪律兜**。

> ⚠️ 本清单本身是**软约束**：它能不能生效，取决于会话里的 agent 是否守规矩。
>
> **2026-10-21 更新**：另一条路已经落地 —— `role-guard` 的 **`restrict({ deny })` 硬掩码**会把
> **非 writer 成员的写类 MCP 从模型工具面移除**（线上实测 `count=498`、`TOOL_ABSENT` ×2）。
> 它不是"逐工具审批"，但确实让**只读成员拿不到写工具**。
> **路线 B（stdio 审批代理）仍未实施**；若将来需要"**逐次**审批"，那仍然只有它。

---

## 1. 判定原则：只读放行，写与执行先问

工具分两类，**看它对世界有没有副作用**：

- **只读类**（`report_*` / `get_*` / `list_*` / `check_*` / `parse_*` / `xdc_lint` …）
  → **直接调，不用问**。这类工具本来也不需要审批，问了纯属打断。
- **写入 / 执行类**（会改文件、起进程、烧板子、跑任意代码）
  → **调用前必须先向用户说明"要调哪个、参数是什么、预期影响"，得到同意再调**。

特殊情况：**即使工具名看着像只读，只要它接受能影响输出的"执行性"参数**
（如 `run_tcl` 接受任意命令文本），按写入类处理。

---

## 2. 高危清单（拦截范围）

### 2.1 `mcp__vivado__*` —— 必问

| 工具 | 为什么要问 |
| --- | --- |
| `run_tcl` | **任意 TCL 直接跑**。等于把 Vivado 的全部能力交出去，含写盘、起进程、开 GUI。Codex 侧也仅有它为 `approve`。 |
| `start_session` | 起一个 Vivado 进程（GUI 模式会弹窗）。Codex 侧同为 `approve`。 |
| `stop_session` | 关闭会话；若用户手上有未存的 Vivado 工作，会丢。 |
| `generate_bitstream` | 生成比特流 = 产出可用于烧板的制品。 |
| `program_device` | **烧 FPGA**。板子上的行为立刻改变。 |
| `run_synthesis` / `run_implementation` | 长任务、改 `runs/` 下的产物、占用机器。 |
| `safe_tcl` | 与 `run_tcl` 同性质，只是参数转义更安全。**同样按任意 TCL 对待。** |
| `set_wave_zoom` / `set_wave_analog` | 会**改用户的 wcfg 磁盘文件**（close+open 重载），静默覆盖手设属性。 |

### 2.2 `mcp__fpga-mcp__*` —— 必问

这个服务器工具面极大（几百个），但**危险集中在几个逃生舱口和写文件上**。
Codex 侧只标了 `ping_backend` / `read_file` / `read_file_lines` /
`append_to_file` / `set_backend`——注意它连 `read_file` 都拦了（因为读的是宿主任意路径，
能读出仓库外的东西）。

| 工具 | 为什么要问 |
| --- | --- |
| `a_exec` / `viv_exec` / `viv_xsct_exec` | **任意系统命令 / 任意 shell**。最高危。 |
| `exec_tcl` | 任意后端 TCL，同 `run_tcl`。 |
| `a_append_to_file` / `append_to_file` | **直接写文件，可追加任意内容**。Codex 侧标了 `approve`。 |
| `a_create_source_file` / `create_source_file` / `a_create_constraint_file` / `create_constraint_file` | 建文件进工程。 |
| `a_remove_file` / `remove_file` / `a_import_files` / `import_files` / `a_export_files` | 增删工程文件、往外部目录导出。 |
| `set_backend` / `a_set_backend` | 切后端 = 改变后续所有命令的落点。Codex 侧标了 `approve`。 |
| `a_program_device` / `program_device` / `q_program_device_pgm` / `q_run_quartus_pgm` / `viv_program_hw_device` / `viv_xsct_download_bitstream` / `viv_xsct_download_elf` | **烧板子 / 下 ELF**。 |
| `*_generate_bitstream*` / `q_execute_asm` / `viv_write_bitstream*` / `write_bitstream` | 产出可烧制品。 |
| `*_run_syn` / `*_run_pnr` / `*_execute_all_flows` / `q_execute_map/fit/sta` / `run_synthesis` / `run_implementation` | 长任务、写构建产物。 |
| `viv_xsct_*` 系列（除 `version` / `help` / `list_*` / `get_*` / `hsi_get_*` / `read_memory`） | XSCT 是"能跑任意脚本"的调试控制台，凡带 `set_` / `create_` / `write_` / `download` / `reset` / `run_` 的一律按写入类。 |
| `a_set_*` / `q_set_*` / `viv_set_*` 工程参数类 | 改工程约束/属性，会改变综合实现结果。**批量调用前问一次即可**。 |

### 2.3 磁盘写入类（`a_*_file` / `*_write_*` / `*_save_*`）

`set_ip_property` / `save_constraints` / `create_project` / `open_project`（会改 `.jou`）等
**凡会落盘的，按写入类处理**。单次问、成组问，不要每一条都打断。

---

## 3. 明确放行（不用问）

- `mcp__vivado__*`：`list_sessions` / `get_project_info` / `get_run_progress` /
  `get_timing_report` / `get_utilization_report` / `get_io_report` /
  `get_critical_warnings` / `get_ip_status` / `get_next_suggestion` /
  `get_pre_commit_summary` / `xdc_lint` / `xdc_auto_fix`（**dry_run=True 时**）/
  `check_bitstream_readiness` / `verify_io_placement_tool` / `parse_xpr` /
  `parse_bit_header` / `parse_ltx` / `compare_xci` / `inspect_ip_params` /
  `verilog_compile_check`
- `mcp__fpga-mcp__*`：`a_catch` / `*_report_*` / `*_get_*` / `*_list_*` /
  `*_file_exists` / `*_read_file*`／`a_pwd` / `a_get_*` / `q_report_*` / `viv_report_*` /
  `status` / `list_backends` / `ping_backend` / `a_file_stat` / `*_file_mtime`

> 例外：`read_file` / `read_file_lines` 本身只读，但**能读宿主任意路径**（含仓库外）。
> 读项目内文件不用问；**要读本工作区/仓库之外的路径时先说明**。

---

## 4. 执行时的自述格式

调高危工具前，先说一句再动，例如：

> 我要调 `mcp__vivado__run_tcl`，命令是 `report_utilization -return_string`。
> 这是只读报告，但工具本身属"任意 TCL"类，故先报备。

用户答"可以 / 继续 / 行"即视为同意**本次**调用（不自动延续到下一次）。
若用户说过"这批都放行"，则该批次内不再逐条问。

---

## 5. 与 Codex 配置的对照（便于日后同步）

Codex 侧已标 `approve` 的 7 条，本清单全部覆盖：

| Codex `config.toml` 条目 | 本清单 |
| --- | --- |
| `[mcp_servers.vivado.tools.run_tcl]` | §2.1 ✅ |
| `[mcp_servers.vivado.tools.start_session]` | §2.1 ✅ |
| `[mcp_servers.fpga-mcp.tools.ping_backend]` | **未拦**（只读探测，放行更合理） |
| `[mcp_servers.fpga-mcp.tools.read_file]` | §3 例外条款（出仓库时问） |
| `[mcp_servers.fpga-mcp.tools.read_file_lines]` | §3 例外条款（出仓库时问） |
| `[mcp_servers.fpga-mcp.tools.append_to_file]` | §2.2 ✅ |
| `[mcp_servers.fpga-mcp.tools.set_backend]` | §2.2 ✅ |

**差异说明**：`ping_backend` 在 Codex 里被标了 `approve`，本清单放行——
它只是探活，无副作用；频繁探测的场景下审批纯属噪声。
`read_file` 权限本清单比 Codex **更松**（仅出仓库时问），若日后觉得不妥，
把 §3 那句例外改成"一律先问"即可，改这一处就够。

**本清单比 Codex 严的地方**：Codex 只拦了 7 个工具，本清单还额外拦了
`exec_tcl` / `a_exec` / `viv_exec` / 各类 `program_device` / `download_*` /
`write_bitstream*` / `remove_file` / `import_files` 等——**这些在 Codex 里是裸奔的**。
理由是它们和已拦工具同性质（任意执行 / 烧板 / 写盘），没有理由只拦一半。

---

## 6. 变更记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-10-08 | 建档。路线 A（纪律清单）定型；判定只拦高危写工具，只读放行。 | 对照 `%USERPROFILE%\.codex\config.toml` 与 `cordis.patch.yml` 实测 |

| 2026-10-21 | **同类目的已部分达成（路线 C）**：`restrict` 硬掩码把非 writer 成员的写类 MCP 从工具面移除，本清单的"软"在**只读成员**上已变成硬。**路线 B 仍未实施**。 | `ARCHITECTURE.md §10.3`；`P1P2-执行记录_2026-10-21.md` §「D5 硬掩码线上验收证据」 |

> 待办（仍未实施）：**路线 B** —— stdio 审批代理，提供**逐次**审批。
> 触发条件：需要"每次调用都过一遍人/规则"的场合；若只是"只读成员别拿到写工具"，路线 C 已经够用。
