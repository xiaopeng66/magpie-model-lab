export function createRunNotes({ document, api, read, apply, drafts = new Map() }) {
  const node = (tag, text) => { const out = document.createElement(tag); if (text !== undefined) out.textContent = text; return out; };
  return { open(id) {
    const initial = read(id), draft = drafts.get(id), root = node('section'), note = node('textarea'), status = node('p'), current = node('p'), actions = node('div'), save = node('button', '保存备注'), refresh = node('button', '读取当前备注并保留草稿');
    root.className = 'run-notes'; root.setAttribute('aria-label', '记录备注'); note.rows = 4; note.maxLength = 4000; note.setAttribute('aria-label', '记录备注'); note.placeholder = '在这里填写此记录的备注';
    note.value = draft?.note ?? initial.annotation?.note ?? '';
    const field = (label, input) => { const row = node('label'); row.className = 'editor-field'; row.append(node('span', label), input); return row; };
    let expected = draft?.expected ?? initial.runRevision ?? initial.annotation?.revision ?? 0, dirty = Boolean(draft), saving = false, conflict = false;
    status.className = current.className = 'help'; status.setAttribute('role', 'status'); save.type = refresh.type = 'button'; save.className = 'primary'; refresh.className = 'quiet'; refresh.hidden = true;
    actions.className = 'run-notes-actions'; actions.append(save, refresh); root.append(field('备注 · 最多 2000 字', note), actions, status, current);
    if (draft) status.textContent = '尚未保存';
    const remember = () => { dirty = true; drafts.set(id, { note: note.value, expected }); if (!conflict) status.textContent = '尚未保存'; };
    note.addEventListener('input', remember);
    const update = value => {
      if (!dirty) { note.value = value.annotation?.note || ''; expected = value.runRevision ?? value.annotation?.revision ?? 0; }
      else if ((value.runRevision ?? value.annotation?.revision ?? 0) !== expected) { conflict = true; save.disabled = true; refresh.hidden = false; status.textContent = '此记录备注或保护状态已更新，草稿保留；读取当前备注并核对后再保存。'; }
    };
    const acknowledge = (value, submitted, message) => {
      const latest = drafts.get(id); dirty = Boolean(latest && latest.note !== submitted.note);
      expected = value.runRevision ?? value.annotation?.revision ?? expected + 1; conflict = false;
      if (dirty) drafts.set(id, { ...latest, expected }); else drafts.delete(id);
      apply(value); status.textContent = dirty ? '已保存提交版本；继续编辑的草稿尚未保存。' : message; refresh.hidden = true; current.textContent = '';
    };
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      try { const detail = await api('api/runs/' + id); apply(detail.annotation); expected = detail.annotation.runRevision ?? detail.annotation.annotation?.revision ?? 0; conflict = false; save.disabled = saving; remember(); status.textContent = '已读取当前备注，草稿保留；再次保存会替换当前备注。'; current.textContent = `当前备注：${detail.annotation.annotation?.note || '无'}`; }
      catch (error) { status.textContent = error.message; }
      finally { refresh.disabled = false; }
    });
    save.addEventListener('click', async () => {
      if (saving || conflict) return; saving = true; save.disabled = true;
      const submitted = { note: note.value };
      const wanted = { runId: id, expectedRunRevision: expected, note: note.value };
      try {
        if ([...wanted.note].length > 2000) throw new Error('备注最多 2000 字');
        const value = await api('api/runs/annotations', { method: 'POST', body: JSON.stringify(wanted) }); acknowledge(value, submitted, '备注已保存');
      } catch (error) {
        remember(); status.textContent = `${error.message}；草稿保留。`; refresh.hidden = false;
        if (error.status === 409) conflict = true;
        else if (!error.status || error.status >= 500) {
          try { const remote = (await api('api/runs/' + id)).annotation; if ((remote.runRevision ?? remote.annotation?.revision ?? 0) > wanted.expectedRunRevision && (remote.annotation?.note || '') === wanted.note) acknowledge(remote, submitted, '已读取并确认备注保存成功'); else apply(remote); }
          catch { /* The draft remains available until an explicit read. */ }
        }
      } finally { saving = false; save.disabled = conflict; }
    });
    update(initial); return { root, update };
  } };
}
