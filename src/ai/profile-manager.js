import { escapeHtml, showToast } from '../../ui-renderer.js';
import { aiService } from '../../ai-service.js';
import { AI_PROVIDERS, getProviderConfig } from '../../ai-providers.mjs';
import { confirmDialog } from '../ui/confirm-dialog.js';

// ==================== AI Profile Manager (Multi-Key UI) ====================
export function initAiProfileManager() {
  const PROVIDER_META = Object.fromEntries(
    Object.entries(AI_PROVIDERS).map(([k, v]) => [k, { icon: v.icon, label: v.label }])
  );

  let _profiles = [];
  let _strategy = 'failover';
  let _activeId = '';
  let _editingId = null; // null = adding new
  let _selectedProvider = null;

  const listEl = document.getElementById('aiProfileList');
  const emptyEl = document.getElementById('aiEmptyState');
  const formEl = document.getElementById('aiProfileForm');
  const badgeEl = document.getElementById('aiStatusBadge');
  const strategyHint = document.getElementById('aiStrategyHint');

  if (!listEl) return;

  // --- Generate provider cards from registry ---
  const gridEl = document.getElementById('aiProviderGrid');
  if (gridEl) {
    gridEl.innerHTML = Object.entries(AI_PROVIDERS).map(([id, p]) =>
      `<button class="ai-provider-card" data-provider="${id}">
        <span class="ai-provider-icon">${p.icon}</span>
        <span class="ai-provider-name">${p.label}</span>
        <span class="ai-provider-desc">${p.desc}</span>
      </button>`
    ).join('');
  }

  // --- Sidebar AI status: click → mở thẳng Cài đặt → AI (không phải tự đi tìm tab) ---
  const sidebarAiRow = document.getElementById('sidebarAiRow');
  if (sidebarAiRow) {
    sidebarAiRow.onclick = () => {
      const settingsTab = document.getElementById('tabSettings');
      if (settingsTab) settingsTab.click();
      if (typeof window.switchSettingsSubTab === 'function') window.switchSettingsSubTab('ai');
    };
  }

  // --- Datalist ô Model: gợi ý từ registry, sau khi Test thì nạp model thật từ API ---
  function updateModelDatalist(provider, liveModels) {
    const dl = document.getElementById('aiModelDatalist');
    if (!dl) return;
    const cfg = getProviderConfig(provider);
    const suggested = Array.isArray(cfg.models) ? cfg.models : [];
    const live = Array.isArray(liveModels) ? liveModels.filter(Boolean) : [];
    const merged = [...new Set([...live, ...suggested])];
    dl.innerHTML = merged.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
  }

  // --- Test 1 profile ngay trên dòng (dùng chung cho nút 🔌 từng dòng và "Test tất cả") ---
  async function testProfileRow(div, p) {
    const testEl = div.querySelector('.ai-profile-meta');
    if (!testEl) return { ok: false, message: '' };
    const orig = testEl.textContent;
    testEl.textContent = '⏳ Đang test...';
    testEl.style.color = '';
    const res = await aiService.testProfile(p);
    testEl.textContent = res.ok ? `✅ ${res.message}` : `❌ ${res.message}`;
    testEl.style.color = res.ok ? 'var(--accent-green)' : 'var(--accent-red)';
    setTimeout(() => { testEl.textContent = orig; testEl.style.color = ''; }, 5000);
    return res;
  }

  // --- Load & Render ---
  async function loadProfiles() {
    const data = await aiService.getProfiles();
    _profiles = data.profiles || [];
    _strategy = data.strategy || 'failover';
    _activeId = data.activeId || '';
    render();
    // Warn immediately if any stored keys could not be decrypted
    const broken = _profiles.filter(p => p.keyError === 'decrypt_failed');
    if (broken.length > 0) {
      showToast(`⚠️ ${broken.length} AI profile không giải mã được API key (do đổi mật khẩu Windows/khác user). Hãy nhập lại key!`, 'error');
    }
  }

  async function persist() {
    await aiService.saveProfiles(_profiles, _strategy, _activeId);
  }

  function render() {
    // Strategy buttons
    document.querySelectorAll('.ai-strategy-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.strategy === _strategy);
    });
    if (strategyHint) {
      strategyHint.textContent = _strategy === 'roundrobin'
        ? 'Xoay vòng tất cả profile đang bật — mỗi lần phân tích dùng 1 profile khác nhau (chia đều chi phí, tránh rate limit).'
        : 'Ưu tiên profile chính, tự động chuyển sang profile khác khi gặp lỗi (429, timeout...).';
    }

    // Profile list
    const items = listEl.querySelectorAll('.ai-profile-item');
    items.forEach(el => el.remove());

    if (emptyEl) emptyEl.style.display = _profiles.length === 0 ? '' : 'none';

    _profiles.forEach(p => {
      const meta = PROVIDER_META[p.provider] || { icon: '❓', label: p.provider };
      const isPrimary = p.id === _activeId;
      const keyBroken = p.keyError === 'decrypt_failed';
      const div = document.createElement('div');
      div.className = `ai-profile-item${p.enabled ? '' : ' disabled'}${isPrimary ? ' is-primary' : ''}${keyBroken ? ' key-broken' : ''}`;
      div.title = keyBroken ? 'API key không thể giải mã — bấm ✏️ để nhập lại key' : (isPrimary ? 'Đang là API chính' : 'Click để chọn làm API chính');
      div.innerHTML = `
        <div class="ai-profile-icon">${meta.icon}</div>
        <div class="ai-profile-info">
          <div class="ai-profile-name">${escapeHtml(p.name)}${isPrimary ? '<span class="primary-badge">Chính</span>' : ''}${keyBroken ? '<span class="key-error-badge">🔑 Lỗi key</span>' : ''}</div>
          <div class="ai-profile-meta">${keyBroken ? '❌ Không giải mã được API key — nhập lại key để sửa' : meta.label + ' · ' + escapeHtml(p.model || 'auto model')}${!keyBroken && p.endpoint ? ' · ' + escapeHtml(p.endpoint.replace(/^https?:\/\//, '').slice(0, 35)) : ''}</div>
        </div>
        <div class="ai-profile-actions">
          <button class="btn btn-ghost btn-sm ai-act-test" title="Test kết nối">🔌</button>
          ${!isPrimary && p.enabled ? '<button class="btn btn-ghost btn-sm ai-act-primary" title="Đặt làm chính">⭐</button>' : ''}
          <button class="btn btn-ghost btn-sm ai-act-edit" title="Sửa">✏️</button>
          <button class="btn btn-ghost btn-sm ai-act-del" title="Xóa">🗑️</button>
          <label class="ai-toggle" title="Bật/Tắt">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
      `;

      // Events — click anywhere on the row to select as primary
      div.addEventListener('click', async (e) => {
        // Ignore clicks on action buttons / toggle
        if (e.target.closest('.ai-profile-actions')) return;
        if (!p.enabled) {
          showToast('Profile đang tắt — bật lên trước khi chọn.', 'warning');
          return;
        }
        if (_activeId !== p.id) {
          _activeId = p.id;
          await persist();
          render();
          showToast(`Đã chọn "${p.name}" làm API chính.`, 'success');
        }
      });

      div.querySelector('.ai-act-test').onclick = async (e) => {
        e.stopPropagation();
        await testProfileRow(div, p);
      };

      const primaryBtn = div.querySelector('.ai-act-primary');
      if (primaryBtn) {
        primaryBtn.onclick = async (e) => {
          e.stopPropagation();
          _activeId = p.id;
          await persist();
          render();
          showToast(`Đã đặt "${p.name}" làm profile chính.`, 'success');
        };
      }

      div.querySelector('.ai-act-edit').onclick = (e) => { e.stopPropagation(); openEditForm(p); };

      div.querySelector('.ai-act-del').onclick = async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog({ title: '⚠️ Xóa AI profile', message: `Xóa profile "${p.name}"?`, danger: true }))) return;
        _profiles = _profiles.filter(x => x.id !== p.id);
        if (_activeId === p.id) _activeId = (_profiles.find(x => x.enabled) || {}).id || '';
        await persist();
        render();
        showToast(`Đã xóa profile "${p.name}".`, 'success');
      };

      div.querySelector('.ai-toggle input').onchange = async (e) => {
        p.enabled = e.target.checked;
        if (!p.enabled && _activeId === p.id) {
          _activeId = (_profiles.find(x => x.enabled && x.id !== p.id) || {}).id || '';
        }
        if (p.enabled && !_activeId) _activeId = p.id;
        await persist();
        render();
      };

      listEl.appendChild(div);
    });

    updateBadge();
    updateSidebarAiStatus();
  }

  function updateBadge() {
    if (!badgeEl) return;
    const enabled = _profiles.filter(p => p.enabled);
    const broken = enabled.filter(p => p.keyError === 'decrypt_failed');
    if (enabled.length === 0) {
      badgeEl.innerHTML = '🔒 Chưa có AI nào hoạt động — phân tích sẽ dùng Offline Regex';
      badgeEl.style.color = '';
    } else if (broken.length === enabled.length) {
      badgeEl.innerHTML = `🔑❌ Tất cả ${enabled.length} AI đều không giải mã được key — hãy nhập lại API key bên dưới`;
      badgeEl.style.color = 'var(--accent-red)';
    } else {
      const names = enabled.map(p => `${(PROVIDER_META[p.provider] || {}).icon || ''} ${escapeHtml(p.name)}${p.keyError === 'decrypt_failed' ? ' ⚠️' : ''}`).join(' · ');
      badgeEl.innerHTML = `🟢 ${enabled.length} AI đang hoạt động: ${names}${_strategy === 'roundrobin' ? ' <em>(xoay vòng)</em>' : ''}`;
      badgeEl.style.color = 'var(--accent-green)';
    }
  }

  function updateSidebarAiStatus() {
    const aiStatusEl = document.getElementById('sidebarAiStatus');
    const aiDotEl = document.getElementById('sidebarAiDot');
    if (!aiStatusEl) return;
    const enabled = _profiles.filter(p => p.enabled);
    if (enabled.length === 0) {
      aiStatusEl.textContent = 'Offline';
      if (aiDotEl) aiDotEl.className = 'status-dot';
    } else {
      aiStatusEl.textContent = enabled.length === 1 ? (PROVIDER_META[enabled[0].provider] || {}).label || 'AI' : `${enabled.length} AI`;
      if (aiDotEl) aiDotEl.className = 'status-dot ai';
    }
  }

  // --- Form Logic ---
  function openAddForm() {
    _editingId = null;
    _selectedProvider = null;
    document.getElementById('aiFormTitle').textContent = '➕ Thêm AI Profile mới';
    document.getElementById('aiProfileName').value = '';
    document.getElementById('aiProfileKey').value = '';
    document.getElementById('aiProfileModel').value = '';
    document.getElementById('aiProfileEndpoint').value = '';
    document.getElementById('aiFormFields').classList.add('hidden');
    document.getElementById('aiProfileTestResult').textContent = '';
    document.querySelectorAll('.ai-provider-card').forEach(c => c.classList.remove('selected'));
    formEl.classList.remove('hidden');
    formEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function openEditForm(profile) {
    _editingId = profile.id;
    _selectedProvider = profile.provider;
    document.getElementById('aiFormTitle').textContent = `✏️ Sửa: ${profile.name}`;
    document.getElementById('aiProfileName').value = profile.name;
    document.getElementById('aiProfileKey').value = profile.apiKey || '';
    document.getElementById('aiProfileModel').value = profile.model || '';
    document.getElementById('aiProfileEndpoint').value = profile.endpoint || '';
    document.getElementById('aiProfileTestResult').textContent = '';
    document.querySelectorAll('.ai-provider-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.provider === profile.provider);
    });
    applyProviderFields(profile.provider);
    formEl.classList.remove('hidden');
    formEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeForm() {
    formEl.classList.add('hidden');
    _editingId = null;
    _selectedProvider = null;
  }

  function applyProviderFields(provider) {
    const keyRow = document.getElementById('aiFormKeyRow');
    const endpointGroup = document.getElementById('aiFormEndpointGroup');
    const lmHint = document.getElementById('aiLmStudioHint');
    const modelInput = document.getElementById('aiProfileModel');
    const endpointInput = document.getElementById('aiProfileEndpoint');
    const nameInput = document.getElementById('aiProfileName');
    const cfg = getProviderConfig(provider);

    document.getElementById('aiFormFields').classList.remove('hidden');

    // Show/hide API key based on registry auth type
    keyRow.style.display = (cfg.auth === 'none') ? 'none' : '';
    // Hint: key is optional for local providers
    const keyInput = document.getElementById('aiProfileKey');
    if (keyInput) keyInput.placeholder = cfg.local ? 'API Key (tuỳ chọn — bỏ trống nếu không dùng)' : 'API Key';
    // Show endpoint field based on registry
    endpointGroup.classList.toggle('hidden', !cfg.showEndpoint);
    // LM Studio hint
    lmHint.classList.toggle('hidden', provider !== 'lmstudio');
    // Model gợi ý theo provider (datalist — reset về gợi ý chuẩn)
    updateModelDatalist(provider);
    // Link "Lấy API key" theo provider (ẩn với provider local/custom)
    const keyUrlHint = document.getElementById('aiKeyUrlHint');
    const keyUrlLink = document.getElementById('aiKeyUrlLink');
    if (keyUrlHint && keyUrlLink) {
      if (cfg.keyUrl) {
        keyUrlLink.href = cfg.keyUrl;
        keyUrlHint.classList.remove('hidden');
      } else {
        keyUrlHint.classList.add('hidden');
      }
    }

    // Defaults
    if (!_editingId) {
      modelInput.value = cfg.defaultModel || '';
      if (cfg.local && cfg.endpoint) {
        endpointInput.value = cfg.endpoint;
        if (!nameInput.value) nameInput.value = `${cfg.label} Local`;
      } else if (provider === 'custom') {
        endpointInput.value = '';
      } else {
        if (!nameInput.value) nameInput.value = `${cfg.label} Key ${_profiles.filter(p => p.provider === provider).length + 1}`;
      }
    }
  }

  // --- Event Bindings ---
  const btnAdd = document.getElementById('btnAddAiProfile');
  if (btnAdd) btnAdd.onclick = openAddForm;

  const btnClose = document.getElementById('btnCloseAiForm');
  if (btnClose) btnClose.onclick = closeForm;

  const btnCancel = document.getElementById('btnCancelAiForm');
  if (btnCancel) btnCancel.onclick = closeForm;

  // Provider quick-pick
  document.querySelectorAll('.ai-provider-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('.ai-provider-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _selectedProvider = card.dataset.provider;
      applyProviderFields(_selectedProvider);
    };
  });

  // Strategy buttons
  document.querySelectorAll('.ai-strategy-btn').forEach(btn => {
    btn.onclick = async () => {
      _strategy = btn.dataset.strategy;
      await persist();
      render();
    };
  });

  // --- Test tất cả profile đang bật (tuần tự để tránh dồn rate limit) ---
  const btnTestAll = document.getElementById('btnTestAllAiProfiles');
  if (btnTestAll) {
    btnTestAll.onclick = async () => {
      if (btnTestAll.disabled) return;
      const targets = _profiles.filter(p => p.enabled && p.keyError !== 'decrypt_failed');
      if (targets.length === 0) {
        showToast('Không có profile nào đang bật để test.', 'warn');
        return;
      }
      const rows = Array.from(listEl.querySelectorAll('.ai-profile-item'));
      btnTestAll.disabled = true;
      const oldLabel = btnTestAll.textContent;
      let okCount = 0;
      try {
        for (let i = 0; i < targets.length; i++) {
          btnTestAll.textContent = `⏳ ${i + 1}/${targets.length}...`;
          const rowIdx = _profiles.indexOf(targets[i]);
          if (rows[rowIdx]) {
            const res = await testProfileRow(rows[rowIdx], targets[i]);
            if (res.ok) okCount++;
          }
        }
        showToast(`🔌 Kết quả test: ${okCount}/${targets.length} profile OK.`, okCount === targets.length ? 'success' : 'warning');
      } finally {
        btnTestAll.disabled = false;
        btnTestAll.textContent = oldLabel;
      }
    };
  }

  // Toggle key visibility
  const btnToggleKey = document.getElementById('btnToggleProfileKey');
  const keyInput = document.getElementById('aiProfileKey');
  if (btnToggleKey && keyInput) {
    btnToggleKey.onclick = () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    };
  }

  // Test connection from form
  const btnTest = document.getElementById('btnTestAiProfile');
  if (btnTest) {
    btnTest.onclick = async () => {
      const resultEl = document.getElementById('aiProfileTestResult');
      if (!_selectedProvider) { showToast('Chọn provider trước!', 'warn'); return; }
      const profile = {
        provider: _selectedProvider,
        apiKey: document.getElementById('aiProfileKey').value.trim(),
        model: document.getElementById('aiProfileModel').value.trim(),
        endpoint: document.getElementById('aiProfileEndpoint').value.trim()
      };
      resultEl.textContent = '⏳ Đang kiểm tra kết nối...';
      resultEl.className = 'ai-test-result loading';
      const res = await aiService.testProfile(profile);
      resultEl.textContent = res.ok ? `✅ ${res.message}` : `❌ ${res.message}`;
      resultEl.className = 'ai-test-result ' + (res.ok ? 'ok' : 'fail');
      // Nạp model thật trả về từ API vào datalist để chọn thay vì gõ tay
      if (res.ok && Array.isArray(res.models) && res.models.length) {
        updateModelDatalist(_selectedProvider, res.models);
        if (!profile.model) {
          document.getElementById('aiProfileModel').placeholder = res.models[0];
        }
      }
    };
  }

  // Save profile
  const btnSave = document.getElementById('btnSaveAiProfile');
  if (btnSave) {
    btnSave.onclick = async () => {
      if (!_selectedProvider) { showToast('Hãy chọn provider (Gemini, LM Studio, OpenAI, Custom)!', 'error'); return; }

      const name = document.getElementById('aiProfileName').value.trim() || `${(PROVIDER_META[_selectedProvider] || {}).label} profile`;
      const apiKey = document.getElementById('aiProfileKey').value.trim();
      const model = document.getElementById('aiProfileModel').value.trim();
      const endpoint = document.getElementById('aiProfileEndpoint').value.trim();

      // Validation — API key required for cloud providers, optional for local
      const selCfg = getProviderConfig(_selectedProvider);
      if (!selCfg.local && !apiKey) {
        showToast('Vui lòng nhập API Key!', 'error');
        return;
      }
      if (_selectedProvider === 'custom' && !endpoint) {
        showToast('Vui lòng nhập Endpoint URL!', 'error');
        return;
      }

      if (_editingId) {
        // Update existing (strip stale keyError — new key will be re-encrypted)
        const idx = _profiles.findIndex(p => p.id === _editingId);
        if (idx >= 0) {
          const { keyError: _stale, ...rest } = _profiles[idx];
          _profiles[idx] = { ...rest, name, provider: _selectedProvider, apiKey, model, endpoint };
        }
      } else {
        // Add new
        const newProfile = {
          id: 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          name,
          provider: _selectedProvider,
          apiKey,
          model,
          endpoint,
          enabled: true
        };
        _profiles.push(newProfile);
        if (!_activeId) _activeId = newProfile.id;
      }

      await persist();
      const wasEditing = _editingId;
      _editingId = null;
      closeForm();
      render();
      showToast(wasEditing ? `Đã cập nhật profile "${name}"!` : `Đã thêm profile "${name}"! Key được mã hóa an toàn.`, 'success');
    };
  }

  // Initial load
  loadProfiles();
}
