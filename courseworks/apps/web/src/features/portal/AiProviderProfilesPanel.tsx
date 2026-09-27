import { FormEvent, useEffect, useState } from "react";

import { apiFetch } from "../../shared/api/client";
import type { UserRole } from "../../shared/types";
import { Icon } from "../workspace/workspace-icons";

type ProviderLevel = "high" | "medium" | "low";

type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  level: ProviderLevel;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
  selected: boolean;
  updatedAt: string;
};

type ProfileDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  level: ProviderLevel;
};

type ClassProviderContext = {
  currentClass: {
    id: string;
    invitationCode: string;
    courseName: string | null;
    className: string | null;
  } | null;
  assignment: {
    profileId: string;
    profileName: string;
    baseUrl: string;
    model: string;
    level: ProviderLevel;
    enforced: boolean;
    dailyTokenLimit: number | null;
    quotaStatus: {
      usageDate: string;
      dailyTokenLimit: number;
      usedTokens: number;
      remainingTokens: number;
    } | null;
  } | null;
};

const EMPTY_DRAFT: ProfileDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  level: "medium",
};

const LEVEL_LABELS: Record<ProviderLevel, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

function isBundledPlaceholderProfile(profile: ProviderProfile | null) {
  return !!profile
    && profile.baseUrl === "http://127.0.0.1:11434/v1"
    && profile.model === "gpt-oss:120b";
}

export function AiProviderProfilesPanel({ token, role }: { token: string; role: UserRole }) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [classProvider, setClassProvider] = useState<ClassProviderContext | null>(null);
  const [classDialogOpen, setClassDialogOpen] = useState(false);
  const [classProfileId, setClassProfileId] = useState("");
  const [classEnforced, setClassEnforced] = useState(false);
  const [classDailyTokenLimit, setClassDailyTokenLimit] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  async function loadProfiles() {
    try {
      const data = await apiFetch<{ profiles: ProviderProfile[] }>("/ai/profiles", { token });
      setProfiles(data.profiles);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法加载 AI Provider Profile。");
    } finally {
      setLoaded(true);
    }
  }

  async function loadClassProvider() {
    try {
      const data = await apiFetch<ClassProviderContext>("/ai/class-provider", { token });
      setClassProvider(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法加载班级 AI Provider。");
    }
  }

  useEffect(() => {
    void Promise.all([loadProfiles(), loadClassProvider()]);
  }, [token]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 5000);
    return () => window.clearTimeout(timer);
  }, [message]);

  function openClassDialog() {
    if (!classProvider?.currentClass) {
      setMessage("请先选择当前工作班级，再为班级指定 AI Provider。");
      return;
    }
    if (!profiles.length) {
      setMessage("请先创建一个 AI Provider Profile。");
      return;
    }
    setClassProfileId(
      classProvider.assignment?.profileId
        ?? profiles.find((profile) => profile.selected)?.id
        ?? profiles[0]!.id,
    );
    setClassEnforced(classProvider.assignment?.enforced ?? false);
    setClassDailyTokenLimit(classProvider.assignment?.dailyTokenLimit?.toString() ?? "");
    setClassDialogOpen(true);
  }

  async function saveClassProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const data = await apiFetch<ClassProviderContext>("/ai/class-provider", {
        method: "PUT",
        token,
        body: JSON.stringify({
          profileId: classProfileId,
          enforced: classEnforced,
          dailyTokenLimit: classDailyTokenLimit.trim()
            ? Number.parseInt(classDailyTokenLimit, 10)
            : null,
        }),
      });
      setClassProvider(data);
      setClassDialogOpen(false);
      setMessage(classEnforced
        ? "已指定并强制当前班级使用此 AI Provider。"
        : "已将此 AI Provider 设为当前班级的推荐配置。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "指定班级 AI Provider 失败。");
    } finally {
      setBusy(false);
    }
  }

  async function clearClassProvider() {
    setBusy(true);
    setMessage(null);
    try {
      const data = await apiFetch<ClassProviderContext>("/ai/class-provider", {
        method: "DELETE",
        token,
      });
      setClassProvider(data);
      setClassDialogOpen(false);
      setMessage("已取消当前班级的 AI Provider 指定。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "取消班级 AI Provider 失败。");
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setModels([]);
    setEditorMessage(null);
    setEditorOpen(true);
  }

  function openEdit(profile: ProviderProfile) {
    setEditing(profile);
    setDraft({
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: "",
      model: profile.model,
      level: profile.level,
    });
    setModels([]);
    setEditorMessage(null);
    setEditorOpen(true);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setEditorMessage(null);
    try {
      await apiFetch(editing ? `/ai/profiles/${editing.id}` : "/ai/profiles", {
        method: editing ? "PUT" : "POST",
        token,
        body: JSON.stringify({
          ...draft,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        }),
      });
      setEditorOpen(false);
      setMessage(editing ? "Profile 已更新。" : "Profile 已创建并可立即使用。");
      await loadProfiles();
    } catch (error) {
      setEditorMessage(error instanceof Error ? error.message : "保存 Profile 失败。");
    } finally {
      setBusy(false);
    }
  }

  async function selectProfile(profile: ProviderProfile) {
    if (profile.selected || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/ai/profiles/${profile.id}/select`, { method: "POST", token });
      setMessage(`已切换到 ${profile.name}，AES 和后续接入的服务将使用此配置。`);
      await loadProfiles();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "切换 Profile 失败。");
    } finally {
      setBusy(false);
    }
  }

  async function selectClassProfile() {
    if (busy || !classProvider?.assignment) return;
    setBusy(true);
    setMessage(null);
    try {
      const data = await apiFetch<ClassProviderContext>("/ai/class-provider/select", { method: "POST", token });
      setClassProvider(data);
      await loadProfiles();
      setMessage("已选用班级 AI Provider 引用；教师更新配置后会自动同步。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "选用班级 AI Provider 失败。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteProfile(profile: ProviderProfile) {
    if (!window.confirm(`确认删除 AI Provider Profile“${profile.name}”吗？`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/ai/profiles/${profile.id}`, { method: "DELETE", token });
      setMessage("Profile 已删除。若它是当前配置，系统已自动选择另一个可用 Profile。");
      await Promise.all([loadProfiles(), loadClassProvider()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除 Profile 失败。");
    } finally {
      setBusy(false);
    }
  }

  const selectedProfile = profiles.find((profile) => profile.selected) ?? null;
  const studentProviderLocked = role === "student" && classProvider?.assignment?.enforced === true;
  const studentUsesClassDefault = role === "student"
    && !!classProvider?.assignment
    && (studentProviderLocked || !selectedProfile || isBundledPlaceholderProfile(selectedProfile));
  const effectiveProvider = studentUsesClassDefault && classProvider?.assignment
    ? {
        name: classProvider.assignment.profileName,
        baseUrl: classProvider.assignment.baseUrl,
        model: classProvider.assignment.model,
        level: classProvider.assignment.level,
      }
    : selectedProfile;
  const classReferenceVisible = role === "student" && !!classProvider?.assignment;
  const personalProfilesForList = classReferenceVisible
    ? profiles.filter((profile) => !isBundledPlaceholderProfile(profile))
    : profiles;
  const visibleProfileCount = personalProfilesForList.length + (classReferenceVisible ? 1 : 0);

  function draftPayload() {
    return {
      ...(editing ? { profileId: editing.id } : {}),
      baseUrl: draft.baseUrl,
      model: draft.model,
      level: draft.level,
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    };
  }

  async function testConnection() {
    setTesting(true);
    setEditorMessage("正在测试连接...");
    try {
      const data = await apiFetch<{ message: string }>("/ai/profiles/test", {
        method: "POST",
        token,
        body: JSON.stringify(draftPayload()),
      });
      setEditorMessage(`连接成功：${data.message}`);
    } catch (error) {
      setEditorMessage(error instanceof Error ? error.message : "连接测试失败。");
    } finally {
      setTesting(false);
    }
  }

  async function discoverModels() {
    setDiscovering(true);
    setEditorMessage("正在读取模型列表...");
    try {
      const data = await apiFetch<{ models: string[] }>("/ai/models/discover", {
        method: "POST",
        token,
        body: JSON.stringify({
          ...(editing ? { profileId: editing.id } : {}),
          baseUrl: draft.baseUrl,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        }),
      });
      setModels(data.models);
      setEditorMessage(`已读取 ${data.models.length} 个模型。`);
    } catch (error) {
      setModels([]);
      setEditorMessage(error instanceof Error ? error.message : "无法读取模型列表。");
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <section className="provider-profiles" id="ai-provider-profiles" aria-labelledby="provider-profiles-title">
      <div className="provider-profiles-heading">
        <div>
          <span>全局配置</span>
          <h2 id="provider-profiles-title">AI Provider <small>OpenAI compatible</small></h2>
        </div>
        <div className="provider-heading-actions">
          {role === "teacher" ? (
            <button className="ghost-button" onClick={openClassDialog} type="button">
              <Icon name="users" size={17} /> 班级设置
            </button>
          ) : null}
          <button
            aria-controls="provider-profile-details"
            aria-expanded={detailsOpen}
            className="ghost-button provider-manage-button"
            onClick={() => setDetailsOpen((open) => !open)}
            type="button"
          >
            <Icon name="settings" size={17} /> {detailsOpen ? "收起" : "管理"}
          </button>
        </div>
      </div>
      {message ? <div className="notice">{message}</div> : null}
      <div className="provider-current-summary">
        <span className="provider-current-icon"><Icon name="spark" size={21} /></span>
        <div className="provider-current-profile">
          <small>{studentUsesClassDefault ? "当前生效的班级配置" : "当前 AI Provider"}</small>
          <strong>{loaded ? effectiveProvider?.name || "尚未配置" : "正在加载..."}</strong>
          {effectiveProvider ? (
            <>
              <span><code>{effectiveProvider.model}</code><i />级别：{LEVEL_LABELS[effectiveProvider.level]}</span>
              <span>{effectiveProvider.baseUrl}</span>
            </>
          ) : null}
        </div>
        <div className="provider-current-policy">
          <small>{classProvider?.currentClass?.className || "当前班级"}</small>
          {classProvider?.assignment ? (
            <>
              <strong>{classProvider.assignment.enforced ? "强制使用班级配置" : "班级推荐配置"}</strong>
              <span>{classProvider.assignment.profileName} · {classProvider.assignment.model}</span>
              <span>{classProvider.assignment.baseUrl}</span>
              <span>
                每名学生每日：{classProvider.assignment.dailyTokenLimit?.toLocaleString() ?? "不限"} Token
                {classProvider.assignment.quotaStatus
                  ? ` · 今日剩余 ${classProvider.assignment.quotaStatus.remainingTokens.toLocaleString()}`
                  : ""}
              </span>
            </>
          ) : (
            <strong>未指定班级配置</strong>
          )}
        </div>
        {classProvider?.assignment ? (
          <span className="class-provider-status">{classProvider.assignment.enforced ? "已锁定" : "推荐"}</span>
        ) : null}
      </div>
      {detailsOpen ? (
        <div className="provider-profile-details" id="provider-profile-details">
          <div className="provider-profile-toolbar">
            <div>
              <strong>Provider Profiles</strong>
              <small>{visibleProfileCount} 个可用配置</small>
            </div>
            <button className="primary-button provider-add-button" onClick={openCreate} type="button">
              <Icon name="plus" size={17} /> 新建 Profile
            </button>
          </div>
          {!loaded ? <p className="provider-empty">正在加载 Profile...</p> : visibleProfileCount ? (
            <div className="provider-profile-list">
              {classReferenceVisible && classProvider?.assignment ? (
                <article
                  className={studentUsesClassDefault ? "provider-profile selected" : "provider-profile"}
                  key={`class-${classProvider.assignment.profileId}`}
                >
                  <div className="provider-profile-main">
                    <div className="provider-profile-title">
                      <strong>{classProvider.assignment.profileName}</strong>
                      {studentUsesClassDefault ? <span><Icon name="check" size={13} /> 班级默认</span> : null}
                      <span>引用</span>
                    </div>
                    <code>{classProvider.assignment.model}</code>
                    <small>{classProvider.assignment.baseUrl}</small>
                  </div>
                  <div className="provider-profile-meta">
                    <span>级别：{LEVEL_LABELS[classProvider.assignment.level]}</span>
                    <span>来源：{classProvider.currentClass?.className || "当前班级"}</span>
                    <span>每日配额：{classProvider.assignment.dailyTokenLimit?.toLocaleString() ?? "不限"} Token</span>
                    {classProvider.assignment.quotaStatus ? (
                      <span>
                        今日已用 {classProvider.assignment.quotaStatus.usedTokens.toLocaleString()}，剩余 {classProvider.assignment.quotaStatus.remainingTokens.toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                  <div className="provider-profile-actions">
                    {!studentUsesClassDefault ? (
                      <button className="ghost-button compact" disabled={busy} onClick={() => void selectClassProfile()} type="button">设为当前</button>
                    ) : null}
                  </div>
                </article>
              ) : null}
              {personalProfilesForList.map((profile) => (
                <article className={profile.selected && !studentUsesClassDefault ? "provider-profile selected" : "provider-profile"} key={profile.id}>
                  <div className="provider-profile-main">
                    <div className="provider-profile-title">
                      <strong>{profile.name}</strong>
                      {profile.selected && !studentUsesClassDefault ? <span><Icon name="check" size={13} /> 当前使用</span> : null}
                      {role === "teacher" && classProvider?.assignment?.profileId === profile.id ? <span>班级指定</span> : null}
                    </div>
                    <code>{profile.model}</code>
                    <small>{profile.baseUrl}</small>
                  </div>
                  <div className="provider-profile-meta">
                    <span>级别：{LEVEL_LABELS[profile.level]}</span>
                    <span>API Key：{profile.apiKeyMasked || "未配置"}</span>
                  </div>
                  <div className="provider-profile-actions">
                    {!profile.selected ? (
                      <button
                        className="ghost-button compact"
                        disabled={busy || studentProviderLocked}
                        onClick={() => void selectProfile(profile)}
                        title={studentProviderLocked ? "当前班级已强制使用教师指定的 AI Provider" : undefined}
                        type="button"
                      >设为当前</button>
                    ) : null}
                    <button aria-label={`编辑 ${profile.name}`} className="provider-icon-button" disabled={busy} onClick={() => openEdit(profile)} title="编辑 Profile" type="button">
                      <Icon name="edit" size={17} />
                    </button>
                    <button aria-label={`删除 ${profile.name}`} className="provider-icon-button danger" disabled={busy} onClick={() => void deleteProfile(profile)} title="删除 Profile" type="button">
                      <Icon name="trash" size={17} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="provider-empty">
              <Icon name="key" size={24} />
              <strong>尚未配置 AI Provider</strong>
              <span>创建一个 Profile 后即可在 AES 中使用 AI。</span>
            </div>
          )}
        </div>
      ) : null}

      {editorOpen ? (
        <div className="class-modal-backdrop" onMouseDown={() => { if (!busy) setEditorOpen(false); }}>
          <form className="class-create-dialog provider-editor" onMouseDown={(event) => event.stopPropagation()} onSubmit={saveProfile} role="dialog" aria-modal="true" aria-labelledby="provider-editor-title">
            <div className="class-dialog-header">
              <div><span>AI PROVIDER</span><h2 id="provider-editor-title">{editing ? "编辑 Profile" : "新建 Profile"}</h2></div>
              <button aria-label="关闭 Profile 编辑窗口" className="class-dialog-close" disabled={busy} onClick={() => setEditorOpen(false)} title="关闭" type="button"><Icon name="close" size={17} /></button>
            </div>
            <div className="class-create-form">
              <label>Profile 名称<input autoFocus value={draft.name} maxLength={128} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
              <label>Base URL<input value={draft.baseUrl} onChange={(event) => { setDraft({ ...draft, baseUrl: event.target.value }); setModels([]); }} placeholder="https://api.example.com/v1" required /></label>
              <label>API Key<input autoComplete="off" value={draft.apiKey} onChange={(event) => { setDraft({ ...draft, apiKey: event.target.value }); setModels([]); }} placeholder={editing?.apiKeyConfigured ? `留空则保留 ${editing.apiKeyMasked}` : "请输入 API Key"} required={!editing?.apiKeyConfigured} type="password" /></label>
              <label>模型名称
                <span className="provider-model-control">
                  <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} required />
                  <button className="ghost-button compact" disabled={discovering || !draft.baseUrl.trim()} onClick={() => void discoverModels()} type="button">{discovering ? "读取中..." : "读取模型"}</button>
                </span>
              </label>
              {models.length ? (
                <label>已读取的模型（{models.length}）
                  <select
                    className="provider-model-select"
                    onChange={(event) => {
                      if (event.target.value) setDraft({ ...draft, model: event.target.value });
                    }}
                    value={models.includes(draft.model) ? draft.model : ""}
                  >
                    <option value="">请选择模型</option>
                    {models.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
              ) : null}
              <fieldset className="provider-level-field">
                <legend>级别</legend>
                <div className="provider-level-options">
                  {(["high", "medium", "low"] as const).map((level) => (
                    <button className={draft.level === level ? "active" : ""} key={level} onClick={() => setDraft({ ...draft, level })} type="button">{LEVEL_LABELS[level]}</button>
                  ))}
                </div>
              </fieldset>
            </div>
            {editorMessage ? <div className="provider-editor-message">{editorMessage}</div> : null}
            <div className="class-dialog-actions provider-editor-actions">
              <button className="ghost-button" disabled={busy || testing} onClick={() => void testConnection()} type="button">{testing ? "测试中..." : "测试连接"}</button>
              <span />
              <button className="ghost-button" disabled={busy} onClick={() => setEditorOpen(false)} type="button">取消</button>
              <button className="primary-button" disabled={busy || testing} type="submit">{busy ? "保存中..." : "保存"}</button>
            </div>
          </form>
        </div>
      ) : null}

      {classDialogOpen && role === "teacher" ? (
        <div className="class-modal-backdrop" onMouseDown={() => { if (!busy) setClassDialogOpen(false); }}>
          <form className="class-create-dialog class-provider-dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={saveClassProvider} role="dialog" aria-modal="true" aria-labelledby="class-provider-dialog-title">
            <div className="class-dialog-header">
              <div><span>班级 AI</span><h2 id="class-provider-dialog-title">为班级指定 AI Provider</h2></div>
              <button aria-label="关闭班级 AI 设置窗口" className="class-dialog-close" disabled={busy} onClick={() => setClassDialogOpen(false)} title="关闭" type="button"><Icon name="close" size={17} /></button>
            </div>
            <div className="class-provider-dialog-body">
              <div className="class-provider-target">
                <small>当前工作班级</small>
                <strong>{classProvider?.currentClass?.className || "未命名班级"}</strong>
                <span>{classProvider?.currentClass?.courseName || "未命名课程"}</span>
              </div>
              <label>AI Provider Profile
                <select value={classProfileId} onChange={(event) => setClassProfileId(event.target.value)} required>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>
                  ))}
                </select>
              </label>
              <label>每名学生每日 Token 配额（0 表示不限制额度）
                <input
                  inputMode="numeric"
                  max={100000000}
                  min={0}
                  onChange={(event) => setClassDailyTokenLimit(event.target.value)}
                  placeholder="0"
                  step={1000}
                  type="number"
                  value={classDailyTokenLimit}
                />
                <small className="class-provider-field-help">仅在学生使用这个班级 Profile 引用时计数；学生自己的 Profile 不受影响。</small>
              </label>
              <label className="class-provider-force">
                <input checked={classEnforced} onChange={(event) => setClassEnforced(event.target.checked)} type="checkbox" />
                <span><strong>强制班级使用此 AI Provider</strong><small>勾选后，学生无法切换生效配置，三个系统的 AI 请求都固定使用上面的 Profile。</small></span>
              </label>
            </div>
            <div className="class-dialog-actions class-provider-dialog-actions">
              {classProvider?.assignment ? <button className="ghost-button danger-text" disabled={busy} onClick={() => void clearClassProvider()} type="button">取消班级指定</button> : <span />}
              <span />
              <button className="ghost-button" disabled={busy} onClick={() => setClassDialogOpen(false)} type="button">取消</button>
              <button className="primary-button" disabled={busy || !classProfileId} type="submit">{busy ? "应用中..." : "应用"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
