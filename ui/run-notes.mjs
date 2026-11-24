export function createRunNotes({ document, api, read, apply, drafts = new Map() }) {
  const node = (tag, text) => { const out = document.createElement(tag); if (text !== undefined) out.textContent = text; return out; };
  return { open(id) {
    const initial = read(id), draft = drafts.get(id), root = node('details'), note = node('textarea'), tags = node('input'), status = node('p'), current = node('p'), save = node('button', '保存备注与标签'), refresh = node('button', '读取当前注释并保留草稿');
    root.className = 'settings-details phase-settings-group'; root.append(node('summary', '备注与标签')); note.rows = 4; note.maxLength = 4000; note.setAttribute('aria-label', '记录备注'); tags.setAttribute('aria-label', '记录标签'); tags.placeholder = '用逗号分隔，最多 10 个';
    note.value = draft?.note ?? initial.annotation?.note ?? ''; tags.value = draft?.tags ?? (initial.annotation?.tags || []).join(', ');
    const field = (label, input) => { const row = node('label'); row.className = 'editor-field'; row.append(node('span', label), input); return row; };
    let expected = draft?.expected ?? initial.runRevision ?? initial.annotation?.revision ?? 0, dirty = Boolean(draft), saving = false, conflict = false;
    status.className = current.className = 'help'; status.setAttribute('role', 'status'); save.type = refresh.type = 'button'; save.className = 'primary'; refresh.className = 'quiet'; refresh.hidden = true;
    root.append(field('备注 · 最多 2000 字', note), field('标签 · 每个最多 20 字', tags), save, refresh, status, current);
    const remember = () => { dirty = true; drafts.set(id, { note: note.value, tags: tags.value, expected }); if (!conflict) status.textContent = '尚未保存'; };
    note.addEventListener('input', remember); tags.addEventListener('input', remember);
    const update = value => {
      if (!dirty) { note.value = value.annotation?.note || ''; tags.value = (value.annotation?.tags || []).join(', '); expected = value.runRevision ?? value.annotation?.revision ?? 0; }
      else if ((value.runRevision ?? value.annotation?.revision ?? 0) !== expected) { conflict = true; save.disabled = true; refresh.hidden = false; status.textContent = '此记录注释已更新，草稿保留；读取当前注释并核对后再保存。'; }
    };
    const acknowledge = (value, submitted, message) => {
      const latest = drafts.get(id); dirty = Boolean(latest && (latest.note !== submitted.note || latest.tags !== submitted.tags));
      expected = value.runRevision ?? value.annotation?.revision ?? expected + 1; conflict = false;
      if (dirty) drafts.set(id, { ...latest, expected }); else drafts.delete(id);
      apply(value); status.textContent = dirty ? '已保存提交版本；继续编辑的草稿尚未保存。' : message; refresh.hidden = true;
    };
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try { const detail = await api('api/runs/' + id); apply(detail.annotation); expected = detail.annotation.runRevision ?? detail.annotation.annotation?.revision ?? 0; conflict = false; save.disabled = saving; remember(); status.textContent = '已读取当前注释，草稿保留；再次保存会替换当前备注与标签。'; current.textContent = `当前备注：${detail.annotation.annotation?.note || '无'}；当前标签：${(detail.annotation.annotation?.tags || []).join(', ') || '无'}`; }
      catch (error) { status.textContent = error.message; }
      finally { refresh.disabled = false; }
    });
    save.addEventListener('click', async () => {
      if (saving || conflict) return; saving = true; save.disabled = true;
      const submitted = { note: note.value, tags: tags.value };
      const wanted = { runId: id, expectedRunRevision: expected, note: note.value, tags: tags.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) };
      try {
        if ([...wanted.note].length > 2000 || wanted.tags.length > 10 || wanted.tags.some(tag => [...tag].length > 20) || new Set(wanted.tags).size !== wanted.tags.length) throw new Error('备注最多 2000 字；标签最多 10 个，每个最多 20 字且不能重复');
        const value = await api('api/runs/annotations', { method: 'POST', body: JSON.stringify(wanted) }); acknowledge(value, submitted, '备注与标签已保存');
      } catch (error) {
        remember(); status.textContent = `${error.message}；草稿保留。`; refresh.hidden = false;
        if (error.status === 409) conflict = true;
        else if (!error.status || error.status >= 500) {
          try { const remote = (await api('api/runs/' + id)).annotation; if (remote.annotation?.note === wanted.note && JSON.stringify(remote.annotation.tags || []) === JSON.stringify(wanted.tags)) acknowledge(remote, submitted, '已读取并确认备注与标签保存成功'); else apply(remote); }
          catch { /* The draft remains available until an explicit read. */ }
        }
      } finally { saving = false; save.disabled = conflict; }
    });
    update(initial); return { root, update };
  } };
}
