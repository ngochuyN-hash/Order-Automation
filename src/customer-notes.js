import { dbStore } from '../db-store.js';
import { normalizeText, levenshtein } from '../parser.js';
import { escapeHtml, showToast } from '../ui-renderer.js';

// =========================================================================
//  CUSTOMER SPECIAL-PRICE NOTES MODULE
// =========================================================================
export const CustomerNotes = (() => {
  const STORAGE_KEY = 'order_automation_customer_notes_v1';
  let _notes = [];          // [{ id, name, note }]
  let _editingId = null;    // id đang sửa trong form settings

  // --- Persistence ---
  // Ưu tiên lưu FILE (userData/app-config.json qua IPC) — không bị mất khi
  // rebuild app / đổi origin. Fallback về dbStore (IndexedDB/localStorage)
  // khi chạy ngoài Electron (browser, test).
  async function load() {
    try {
      if (window.electronAPI && window.electronAPI.getCustomerNotes) {
        const fileNotes = await window.electronAPI.getCustomerNotes();
        if (Array.isArray(fileNotes) && fileNotes.length > 0) {
          _notes = fileNotes;
          renderSettingsList();
          return;
        }
        // Migration: dữ liệu cũ còn nằm trong IndexedDB/localStorage → chuyển sang file
        const legacy = await dbStore.get(STORAGE_KEY);
        if (Array.isArray(legacy) && legacy.length > 0) {
          _notes = legacy;
          await window.electronAPI.setCustomerNotes(_notes);
          // Xóa key legacy sau khi migrate thành công — nếu không, khi user xóa
          // hết notes (file lưu []) thì lần load sau đọc lại legacy còn nguyên
          // và toàn bộ notes đã xóa sẽ "hồi sinh".
          try {
            await dbStore.remove(STORAGE_KEY);
          } catch (rmErr) {
            console.warn('CustomerNotes: failed to remove legacy storage key.', rmErr);
          }
          renderSettingsList();
          return;
        }
        _notes = Array.isArray(fileNotes) ? fileNotes : [];
      } else {
        const data = await dbStore.get(STORAGE_KEY);
        _notes = Array.isArray(data) ? data : [];
      }
    } catch (e) {
      console.warn('CustomerNotes: load failed, using empty list.', e);
      _notes = [];
    }
    renderSettingsList();
  }

  async function save() {
    try {
      if (window.electronAPI && window.electronAPI.setCustomerNotes) {
        await window.electronAPI.setCustomerNotes(_notes);
        return;
      }
      await dbStore.set(STORAGE_KEY, _notes);
    } catch (e) {
      console.error('CustomerNotes: save failed.', e);
    }
  }

  // --- CRUD ---
  function addOrUpdate(name, note) {
    name = (name || '').trim();
    note = (note || '').trim();
    if (!name) return false;

    if (_editingId) {
      const idx = _notes.findIndex(n => n.id === _editingId);
      if (idx !== -1) {
        _notes[idx].name = name;
        _notes[idx].note = note;
      }
      _editingId = null;
    } else {
      // Kiểm tra trùng tên (normalized) → cập nhật thay vì tạo mới
      const norm = normalizeText(name);
      const existing = _notes.find(n => normalizeText(n.name) === norm);
      if (existing) {
        existing.name = name;
        existing.note = note;
      } else {
        _notes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, note });
      }
    }
    save();
    renderSettingsList();
    return true;
  }

  function remove(id) {
    _notes = _notes.filter(n => n.id !== id);
    if (_editingId === id) { _editingId = null; clearForm(); }
    save();
    renderSettingsList();
  }

  function startEdit(id) {
    const entry = _notes.find(n => n.id === id);
    if (!entry) return;
    _editingId = id;
    const nameEl = document.getElementById('cnNameInput');
    const noteEl = document.getElementById('cnNoteInput');
    const cancelBtn = document.getElementById('btnClearCnForm');
    if (nameEl) nameEl.value = entry.name;
    if (noteEl) noteEl.value = entry.note;
    if (cancelBtn) cancelBtn.classList.remove('hidden');
  }

  function clearForm() {
    const nameEl = document.getElementById('cnNameInput');
    const noteEl = document.getElementById('cnNoteInput');
    const cancelBtn = document.getElementById('btnClearCnForm');
    if (nameEl) nameEl.value = '';
    if (noteEl) noteEl.value = '';
    if (cancelBtn) cancelBtn.classList.add('hidden');
    _editingId = null;
  }

  // --- Detection: tìm ghi chú khớp với tên khách (fuzzy) ---
  const FUZZY_THRESHOLD = 55; // % tối thiểu để nhận diện

  /**
   * Tính % giống nhau giữa 2 chuỗi đã normalize.
   * Kết hợp: word-overlap (trọng số chính) + Levenshtein toàn chuỗi (bổ trợ).
   */
  function similarityScore(normA, normB) {
    if (normA === normB) return 100;
    if (!normA || !normB) return 0;

    // --- Word-level matching ---
    const wordsA = normA.split(/\s+/).filter(Boolean);
    const wordsB = normB.split(/\s+/).filter(Boolean);
    if (!wordsA.length || !wordsB.length) return 0;

    let matchedWeight = 0;
    const totalWeight = wordsA.length * 2; // mỗi từ tối đa 2 điểm

    for (const wa of wordsA) {
      let best = 0;
      for (const wb of wordsB) {
        if (wa === wb) { best = Math.max(best, 2); break; }
        // Chứa nhau (từ dài >= 3 ký tự)
        if (wa.length >= 3 && wb.length >= 3 && (wa.includes(wb) || wb.includes(wa))) {
          best = Math.max(best, 1.5);
          continue;
        }
        // Levenshtein gần đúng (sai 1-2 ký tự)
        const dist = levenshtein(wa, wb);
        if (dist <= 1 && wa.length >= 3) best = Math.max(best, 1.2);
        else if (dist <= 2 && wa.length >= 5) best = Math.max(best, 0.8);
      }
      matchedWeight += best;
    }

    const wordScore = totalWeight > 0 ? (matchedWeight / totalWeight) * 100 : 0;

    // --- Levenshtein toàn chuỗi (bổ trợ, trọng số thấp) ---
    const maxLen = Math.max(normA.length, normB.length);
    const fullDist = levenshtein(normA, normB);
    const levScore = maxLen > 0 ? Math.max(0, (1 - fullDist / maxLen)) * 100 : 0;

    // Kết hợp: 80% word + 20% levenshtein toàn chuỗi
    return Math.round(wordScore * 0.8 + levScore * 0.2);
  }

  /**
   * Tìm entry khớp nhất với tên khách.
   * Trả về { entry, score } hoặc null.
   */
  function findMatch(customerName) {
    if (!customerName || !_notes.length) return null;
    const normInput = normalizeText(customerName);
    if (!normInput) return null;

    let bestEntry = null;
    let bestScore = 0;

    for (const entry of _notes) {
      const normEntry = normalizeText(entry.name);
      if (!normEntry) continue;

      // Khớp chính xác → 100%
      if (normInput === normEntry) return { entry, score: 100 };

      // Khớp chứa → 95%
      if (normInput.includes(normEntry) || normEntry.includes(normInput)) {
        if (95 > bestScore) { bestScore = 95; bestEntry = entry; }
        continue;
      }

      // Fuzzy matching
      const score = similarityScore(normInput, normEntry);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestScore >= FUZZY_THRESHOLD) {
      return { entry: bestEntry, score: bestScore };
    }
    return null;
  }

  // --- Warning Banner ---
  function checkAndWarn(customerName) {
    const banner = document.getElementById('customerNoteWarning');
    if (!banner) return;
    const result = findMatch(customerName);
    if (result) {
      const { entry, score } = result;
      const titleEl = document.getElementById('cnwTitle');
      const noteEl = document.getElementById('cnwNote');
      const confLabel = score >= 95 ? '' : ` (≈${score}% khớp)`;
      if (titleEl) titleEl.textContent = `⚠️ "${entry.name}" — Khách có đơn giá riêng${confLabel}`;
      if (noteEl) noteEl.textContent = entry.note || '(Không có ghi chú)';
      banner.classList.remove('hidden');
      // Toast cảnh báo thêm
      showToast(`Khách "${entry.name}" có đơn giá riêng${confLabel} — kiểm tra ghi chú!`, 'info');
    } else {
      banner.classList.add('hidden');
    }
  }

  function dismissWarning() {
    const banner = document.getElementById('customerNoteWarning');
    if (banner) banner.classList.add('hidden');
  }

  // --- Settings List Rendering ---
  function renderSettingsList() {
    const container = document.getElementById('customerNoteList');
    if (!container) return;
    if (!_notes.length) {
      container.innerHTML = '<div class="customer-note-empty">Chưa có khách nào trong danh sách.</div>';
      return;
    }
    container.innerHTML = _notes.map(n => `
      <div class="customer-note-item" data-id="${n.id}">
        <div class="cni-body">
          <div class="cni-name">${escapeHtml(n.name)}</div>
          <div class="cni-note">${escapeHtml(n.note || '—')}</div>
        </div>
        <div class="cni-actions">
          <button class="btn btn-ghost btn-sm" onclick="CustomerNotes.startEdit('${n.id}')" title="Sửa">✏️</button>
          <button class="btn btn-outline-danger btn-sm" onclick="CustomerNotes.remove('${n.id}')" title="Xóa">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  // --- Bind UI Events (gọi 1 lần khi init) ---
  function bindEvents() {
    const addBtn = document.getElementById('btnAddCustomerNote');
    const clearBtn = document.getElementById('btnClearCnForm');
    const dismissBtn = document.getElementById('btnDismissCnw');

    if (addBtn) addBtn.addEventListener('click', () => {
      const name = document.getElementById('cnNameInput')?.value;
      const note = document.getElementById('cnNoteInput')?.value;
      if (addOrUpdate(name, note)) {
        clearForm();
        showToast('Đã lưu khách có đơn giá riêng.', 'success');
      } else {
        showToast('Vui lòng nhập tên khách!', 'error');
      }
    });

    if (clearBtn) clearBtn.addEventListener('click', clearForm);
    if (dismissBtn) dismissBtn.addEventListener('click', dismissWarning);
  }

  return { load, addOrUpdate, remove, startEdit, clearForm, findMatch, checkAndWarn, dismissWarning, renderSettingsList, bindEvents };
})();

// Backward compatibility for inline HTML onclick handlers
if (typeof window !== 'undefined') window.CustomerNotes = CustomerNotes;
