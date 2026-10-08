import { db } from '../../db.js';
import { escapeHtml, showToast } from '../../ui-renderer.js';
import { confirmDialog } from '../ui/confirm-dialog.js';

// =========================================================================
//  SELLER MANAGEMENT & ORDER TITLE GENERATION
// =========================================================================

// Default brand prefix mapping
export const DEFAULT_BRAND_PREFIXES = {
  zentor: 'ZNTSG',
  xvil: 'XVIL',
  veltron: 'VELTRON',
  torvex: 'TORVEX'
};

// Get configurable brand prefixes (from localStorage, fallback to defaults)
export function getBrandPrefixes() {
  try {
    const data = localStorage.getItem('brandPrefixes');
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    // ignore
  }
  return { ...DEFAULT_BRAND_PREFIXES };
}

// Save brand prefixes to localStorage
export function saveBrandPrefixes(prefixes) {
  localStorage.setItem('brandPrefixes', JSON.stringify(prefixes));
}

// Seller storage (persisted via db layer → IndexedDB + localStorage)
export function getSellers() {
  return db.getSellers();
}

export function saveSellers(sellers) {
  db.saveSellers(sellers);
}

// ─── Bộ đếm số PO (STT đơn theo brand/tháng) ───────────────────────────────
// BẤT BIẾN: bộ đếm CHỈ được tăng sau khi đơn đã xuất Excel THÀNH CÔNG.
// Sinh tiêu đề (preview / dryRun / xuất bị lỗi) KHÔNG được đốt số — khi xuất
// lỗi rồi xuất lại, đơn giữ nguyên số PO, không phát sinh khoảng trống STT.

// Key localStorage của bộ đếm: orderSeq_{PREFIX}_{YYMM}
function sequenceKeyForBrand(brand) {
  const prefixes = getBrandPrefixes();
  const prefix = prefixes[String(brand).toLowerCase()] || String(brand).toUpperCase();
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `orderSeq_${prefix}_${yy}${mm}`;
}

// Xem STT kế tiếp KHÔNG tăng bộ đếm (preview / dryRun / dựng tiêu đề trước xuất)
export function peekOrderSequence(brand) {
  return parseInt(localStorage.getItem(sequenceKeyForBrand(brand)) || '0', 10) + 1;
}

// Tăng bộ đếm lên ĐÚNG số STT đã dùng trong tiêu đề vừa xuất thành công.
// Guard seq > current: không lùi và không ghi đè STT mới hơn (user có thể đã
// đặt lại STT trong Settings hoặc xuất đơn khác trong lúc export chạy nền).
export function commitOrderSequence(brand, seq) {
  const seqKey = sequenceKeyForBrand(brand);
  const current = parseInt(localStorage.getItem(seqKey) || '0', 10);
  if (seq > current) localStorage.setItem(seqKey, String(seq));
  return seq;
}

// Generate order title: {PREFIX}{YY}{MM}-{sequence}-{Seller name}-{discount}
// HÀM THUẦN (không side-effect): mặc định dùng peekOrderSequence() — truyền
// seq riêng nếu caller muốn ghim số đã peek trước đó.
export function generateOrderTitle(brand, sellerName, discount, seq = peekOrderSequence(brand)) {
  const prefixes = getBrandPrefixes();
  const prefix = prefixes[brand.toLowerCase()] || brand.toUpperCase();
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');

  const seqStr = String(seq).padStart(2, '0');
  
  let formatStr = localStorage.getItem('titleFormat') || '{PREFIX}{YY}{MM}-{sequence}-{Người nhận đặt}-{Chiết khấu}';
  let title = formatStr
    .replace('{PREFIX}', prefix)
    .replace('{YY}', yy)
    .replace('{MM}', mm)
    .replace('{sequence}', seqStr);

  if (sellerName) {
     title = title.replace('{Người nhận đặt}', sellerName);
  } else {
     title = title.replace(/\s*-\s*{Người nhận đặt}/, '');
     title = title.replace(/{Người nhận đặt}\s*-\s*/, '');
     title = title.replace(/{Người nhận đặt}/, '');
  }

  if (discount) {
     title = title.replace('{Chiết khấu}', discount);
  } else {
     title = title.replace(/\s*-\s*{Chiết khấu}/, '');
     title = title.replace(/{Chiết khấu}\s*-\s*/, '');
     title = title.replace(/{Chiết khấu}/, '');
  }
  
  return title;
}

// ─── Searchable seller combobox ────────────────────────────────────────────

// Strip Vietnamese diacritics + lowercase for free-form matching
function normalizeVi(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
}

// ─── Unique seller identity ────────────────────────────────────────────────
// Name alone is NOT unique (e.g. two "Đặng" with CH-3% vs DL -2%).
// The hidden input stores a composite key "name|||discount" so selecting
// the second duplicate returns the CORRECT entry instead of the first match.
const KEY_SEP = '|||';

export function sellerKey(s) {
  return `${s.name}${KEY_SEP}${s.discount || ''}`;
}

export function parseSellerKey(key) {
  const idx = (key || '').indexOf(KEY_SEP);
  if (idx === -1) return { name: key || '', discount: '' }; // legacy plain-name value
  return { name: key.slice(0, idx), discount: key.slice(idx + KEY_SEP.length) };
}

// Exact match on name+discount; fall back to name-only (legacy values / plain names)
export function findSellerByKey(sellers, key) {
  const { name, discount } = parseSellerKey(key);
  return sellers.find(s => s.name === name && (s.discount || '') === discount)
      || sellers.find(s => s.name === name)
      || null;
}

// Seller key (hoặc tên thô) → "Người nhận đặt" ghi lên KiotViet.
// Ưu tiên kvName (tên đúng trên KiotViet); không khớp seller nào thì dùng tên
// đã bỏ hậu tố discount/kèm "(...)".
// MỘT nơi sở hữu quy tắc này: đường GUI (KiotVietAutomation.buildOrderData)
// và đường headless/MCP cùng gọi — trước đây chỉ GUI có nên đơn lên qua MCP
// mất hẳn cột "Người nhận đặt".
export function resolveSellerReceiver(rawKey) {
  const raw = String(rawKey || '').trim();
  if (!raw) return '';
  const parsed = raw.replace(/\|\|\|.*$/, '').replace(/:::.*$/, '').replace(/\s*\([^)]*\)$/, '').trim();
  const sellers = getSellers() || [];
  const matched = findSellerByKey(sellers, raw) || sellers.find(s =>
    (s.id && s.id === raw) ||
    (s.name && s.name === raw) ||
    (s.name && s.name === parsed) ||
    (s.kvName && s.kvName === raw)
  );
  if (matched) return matched.kvName || matched.name || parsed;
  return parsed || raw;
}

let sellerComboBound = false;

// Populate seller dropdown (searchable combobox)
export function populateSellerDropdown() {
  const hidden = document.getElementById('sellerName');
  const searchInput = document.getElementById('sellerSearch');
  const dropdown = document.getElementById('sellerDropdown');
  if (!hidden || !searchInput || !dropdown) return;

  const sellers = getSellers();
  const currentValue = hidden.value;

  // Render all items into dropdown
  renderSellerItems(sellers, '', dropdown);

  // Restore display text for current selection (key-aware: duplicates resolve correctly)
  if (currentValue) {
    const sel = findSellerByKey(sellers, currentValue);
    searchInput.value = sel ? sellerDisplayLabel(sel) : (parseSellerKey(currentValue).name || currentValue);
  }

  // Bind events once
  if (!sellerComboBound) {
    sellerComboBound = true;
    let highlightIdx = -1;

    const open = () => {
      // Show full list on focus; select text so typing replaces it
      renderSellerItems(getSellers(), '', dropdown);
      dropdown.classList.add('visible');
      // Đồng bộ trạng thái ARIA của combobox khi mở danh sách
      searchInput.setAttribute('aria-expanded', 'true');
      highlightIdx = -1;
      searchInput.select();
    };
    const close = () => {
      dropdown.classList.remove('visible');
      searchInput.setAttribute('aria-expanded', 'false');
      highlightIdx = -1;
    };
    const isOpen = () => dropdown.classList.contains('visible');

    searchInput.addEventListener('focus', open);
    searchInput.addEventListener('input', () => {
      // While typing, treat as search — clear hidden value unless exact match
      const typed = searchInput.value.trim();
      const all = getSellers();
      const exact = all.find(s => normalizeVi(sellerDisplayLabel(s)) === normalizeVi(typed));
      hidden.value = exact ? sellerKey(exact) : '';
      renderSellerItems(all, typed, dropdown);
      if (!isOpen()) {
        dropdown.classList.add('visible');
        searchInput.setAttribute('aria-expanded', 'true');
      }
      highlightIdx = -1;
    });

    searchInput.addEventListener('keydown', (e) => {
      const items = dropdown.querySelectorAll('.seller-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen()) { open(); return; }
        highlightIdx = Math.min(highlightIdx + 1, items.length - 1);
        updateHighlight(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen()) { open(); return; }
        highlightIdx = Math.max(highlightIdx - 1, 0);
        updateHighlight(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (isOpen() && highlightIdx >= 0 && items[highlightIdx]) {
          items[highlightIdx].click();
        } else if (isOpen() && items.length === 1) {
          items[0].click();
        }
      } else if (e.key === 'Escape') {
        close();
        restoreDisplay();
      }
    });

    // Close on outside click
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.seller-combobox')) {
        close();
        restoreDisplay();
      }
    });

    function restoreDisplay() {
      const all = getSellers();
      const sel = findSellerByKey(all, hidden.value);
      searchInput.value = sel ? sellerDisplayLabel(sel) : (parseSellerKey(hidden.value).name || '');
    }

    function updateHighlight(items) {
      items.forEach((el, i) => {
        el.classList.toggle('highlighted', i === highlightIdx);
        if (i === highlightIdx) el.scrollIntoView({ block: 'nearest' });
      });
    }
  }
}

// Display label: "Name (discount)"
function sellerDisplayLabel(seller) {
  return seller.discount ? `${seller.name} (${seller.discount})` : seller.name;
}

// Render filtered seller items into dropdown
function renderSellerItems(sellers, query, dropdown) {
  const q = normalizeVi(query.trim());

  // Free-form match: all tokens of query must appear somewhere in the label
  const tokens = q.split(/\s+/).filter(Boolean);
  const filtered = sellers.filter(s => {
    if (!tokens.length) return true;
    const label = normalizeVi(sellerDisplayLabel(s));
    const nameOnly = normalizeVi(s.name);
    return tokens.every(t => label.includes(t) || nameOnly.includes(t));
  });

  if (filtered.length === 0) {
    dropdown.innerHTML = '<div class="seller-item seller-item-empty">Không tìm thấy người nhận đặt</div>';
    return;
  }

  // Mỗi option thật của listbox (#sellerDropdown) phải mang role="option"
  // để khớp pattern combobox/listbox theo ARIA (empty message không được gán role)
  dropdown.innerHTML = filtered.map(s => `
    <div class="seller-item" role="option" data-seller-key="${escapeHtml(sellerKey(s))}">
      <span class="seller-item-name">${escapeHtml(s.name)}</span>
      ${s.discount ? `<span class="seller-item-discount">${escapeHtml(s.discount)}</span>` : ''}
    </div>
  `).join('');

  dropdown.querySelectorAll('.seller-item[data-seller-key]').forEach(el => {
    const selectItem = () => {
      const key = el.getAttribute('data-seller-key');
      const all = getSellers();
      const sel = findSellerByKey(all, key);
      const hidden = document.getElementById('sellerName');
      const searchInput = document.getElementById('sellerSearch');
      hidden.value = key;
      if (searchInput) searchInput.value = sel ? sellerDisplayLabel(sel) : parseSellerKey(key).name;
      dropdown.classList.remove('visible');
      // Chọn xong thì đóng listbox: cập nhật lại aria-expanded của combobox
      searchInput?.setAttribute('aria-expanded', 'false');
    };
    el.addEventListener('mousedown', (e) => { e.preventDefault(); selectItem(); });
    el.addEventListener('click', selectItem); // keyboard Enter
  });
}

// Sort sellers by name (Vietnamese-aware, groups same-name entries together)
window.sortSellersByName = function() {
  const sellers = getSellers();
  sellers.sort((a, b) => {
    const nameA = (a.name || '').toLowerCase();
    const nameB = (b.name || '').toLowerCase();
    const cmp = nameA.localeCompare(nameB, 'vi', { sensitivity: 'base' });
    if (cmp !== 0) return cmp;
    // Same name → sort by discount to keep group stable
    return (a.discount || '').localeCompare(b.discount || '', 'vi', { sensitivity: 'base' });
  });
  saveSellers(sellers);
  populateSellerDropdown();
  openSellerManager(); // Refresh modal
  showToast('Đã sắp xếp theo tên!', 'success');
};

// Move seller up/down in the list
window.moveSeller = function(index, direction) {
  const sellers = getSellers();
  const target = index + direction;
  if (target < 0 || target >= sellers.length) return;
  [sellers[index], sellers[target]] = [sellers[target], sellers[index]];
  saveSellers(sellers);
  populateSellerDropdown();
  openSellerManager(); // Refresh modal
};

// Open seller management modal
export function openSellerManager() {
  const sellers = getSellers();
  
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  
  if (modalTitle) modalTitle.textContent = '️ Quản lý Người nhận đặt';
  
  if (modalBody) {
    modalBody.innerHTML = `
      <div style="margin-bottom: 16px;">
        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
          <input type="text" id="newSellerName" placeholder="Tên hiển thị (VD: Nguyễn Văn B)" 
            style="flex: 1; padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
          <input type="text" id="newSellerKvName" placeholder="Tên trên KiotViet (VD: Nguyễn Văn B)" 
            style="flex: 1; padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
          <input type="text" id="newSellerDiscount" placeholder="Chiết khấu (VD: CH-3%)" 
            style="width: 130px; padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
          <button id="btnAddSeller" style="padding: 8px 16px; background: var(--accent-green); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;"> Thêm</button>
        </div>
        <p style="font-size: 0.75rem; color: var(--text-secondary); margin: -6px 0 10px 2px;">💡 "Tên trên KiotViet" = tên chính xác trong dropdown "Người nhận đặt" trên KiotViet. Để trống nếu trùng tên hiển thị.</p>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <button id="btnSortSellers" style="padding: 6px 14px; background: var(--accent-blue, #3b82f6); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">🔤 Sắp xếp theo tên</button>
          <span style="font-size: 0.75rem; color: var(--text-secondary);">Dùng ↑↓ để tự sắp xếp vị trí</span>
        </div>
      </div>
      <div id="sellerList" style="max-height: 400px; overflow-y: auto;">
        ${sellers.length === 0 ? '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Chưa có người nhận đặt nào</p>' : ''}
        ${sellers.map((seller, index) => `
          <div style="display: flex; align-items: center; gap: 8px; padding: 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm); margin-bottom: 8px;">
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <button onclick="moveSeller(${index}, -1)" ${index === 0 ? 'disabled' : ''} style="padding: 2px 6px; background: ${index === 0 ? 'transparent' : 'var(--bg-secondary)'}; border: 1px solid var(--border-primary); border-radius: 4px; color: ${index === 0 ? 'var(--text-secondary)' : 'var(--text-primary)'}; cursor: ${index === 0 ? 'default' : 'pointer'}; font-size: 0.7rem; line-height: 1; opacity: ${index === 0 ? '0.4' : '1'};">▲</button>
              <button onclick="moveSeller(${index}, 1)" ${index === sellers.length - 1 ? 'disabled' : ''} style="padding: 2px 6px; background: ${index === sellers.length - 1 ? 'transparent' : 'var(--bg-secondary)'}; border: 1px solid var(--border-primary); border-radius: 4px; color: ${index === sellers.length - 1 ? 'var(--text-secondary)' : 'var(--text-primary)'}; cursor: ${index === sellers.length - 1 ? 'default' : 'pointer'}; font-size: 0.7rem; line-height: 1; opacity: ${index === sellers.length - 1 ? '0.4' : '1'};">▼</button>
            </div>
            <div style="flex: 1;">
              <div style="font-weight: 500; color: var(--text-primary);">${escapeHtml(seller.name)}</div>
              ${seller.kvName ? `<div style="font-size: 0.8rem; color: var(--accent-blue, #3b82f6);">KV: ${escapeHtml(seller.kvName)}</div>` : ''}
              ${seller.discount ? `<div style="font-size: 0.85rem; color: var(--text-secondary);">Chiết khấu: ${escapeHtml(seller.discount)}</div>` : ''}
            </div>
            <button onclick="editSeller(${index})" style="padding: 6px 12px; background: var(--accent-yellow); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">✏️ Sửa</button>
            <button onclick="deleteSeller(${index})" style="padding: 6px 12px; background: var(--accent-red); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">🗑️ Xóa</button>
          </div>
        `).join('')}
      </div>
    `;
    
    // Bind add button
    const btnAdd = document.getElementById('btnAddSeller');
    if (btnAdd) {
      btnAdd.onclick = () => {
        const nameInput = document.getElementById('newSellerName');
        const kvNameInput = document.getElementById('newSellerKvName');
        const discountInput = document.getElementById('newSellerDiscount');
        const name = nameInput?.value?.trim();
        const kvName = kvNameInput?.value?.trim();
        const discount = discountInput?.value?.trim();
        
        if (!name) {
          showToast('Vui lòng nhập tên người nhận đặt!', 'error');
          return;
        }
        
        const sellers = getSellers();
        sellers.push({ name, kvName: kvName || '', discount: discount || '' });
        saveSellers(sellers);
        
        populateSellerDropdown();
        openSellerManager(); // Refresh modal
        showToast(`Đã thêm "${name}" thành công!`, 'success');
      };
    }
    
    // Bind sort button
    const btnSort = document.getElementById('btnSortSellers');
    if (btnSort) {
      btnSort.onclick = () => window.sortSellersByName();
    }
  }
  
  const modalOverlay = document.getElementById('modalOverlay');
  if (modalOverlay) modalOverlay.style.display = 'flex';
}

// Edit seller (inline form — prompt() không hoạt động trong Electron)
window.editSeller = function(index) {
  const sellers = getSellers();
  const seller = sellers[index];
  if (!seller) return;

  // Replace the seller row with an inline edit form
  const sellerList = document.getElementById('sellerList');
  if (!sellerList) return;
  const rows = sellerList.children;
  // +1 offset because first child may be the "empty" <p> when list was empty
  const rowEl = rows[index] || rows[index + (sellers.length === 0 ? 1 : 0)];
  if (!rowEl) return;

  rowEl.outerHTML = `
    <div id="editSellerRow_${index}" style="padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--accent-yellow); border-radius: var(--radius-sm); margin-bottom: 8px;">
      <div style="display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
        <input type="text" id="editSellerName_${index}" value="${escapeHtml(seller.name)}" placeholder="Tên hiển thị"
          style="flex: 1; min-width: 140px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
        <input type="text" id="editSellerKvName_${index}" value="${escapeHtml(seller.kvName || '')}" placeholder="Tên trên KiotViet"
          style="flex: 1; min-width: 140px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
        <input type="text" id="editSellerDiscount_${index}" value="${escapeHtml(seller.discount || '')}" placeholder="Chiết khấu"
          style="width: 130px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
      </div>
      <div style="display: flex; gap: 8px;">
        <button id="btnSaveSeller_${index}" style="padding: 6px 16px; background: var(--accent-green); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;">💾 Lưu</button>
        <button id="btnCancelSeller_${index}" style="padding: 6px 16px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); cursor: pointer; font-size: 0.85rem;">✖ Hủy</button>
      </div>
    </div>
  `;

  // Focus the name input
  const nameInput = document.getElementById(`editSellerName_${index}`);
  if (nameInput) { nameInput.focus(); nameInput.select(); }

  // Save handler
  const btnSave = document.getElementById(`btnSaveSeller_${index}`);
  if (btnSave) {
    btnSave.onclick = () => {
      const newName = (document.getElementById(`editSellerName_${index}`)?.value || '').trim();
      const newKvName = (document.getElementById(`editSellerKvName_${index}`)?.value || '').trim();
      const newDiscount = (document.getElementById(`editSellerDiscount_${index}`)?.value || '').trim();
      if (!newName) {
        showToast('Tên không được để trống!', 'error');
        return;
      }
      const allSellers = getSellers();
      allSellers[index] = { name: newName, kvName: newKvName, discount: newDiscount };
      saveSellers(allSellers);
      populateSellerDropdown();
      openSellerManager();
      showToast('Đã cập nhật thành công!', 'success');
    };
  }

  // Cancel handler
  const btnCancel = document.getElementById(`btnCancelSeller_${index}`);
  if (btnCancel) {
    btnCancel.onclick = () => openSellerManager();
  }

  // Allow Enter to save, Escape to cancel
  const editRow = document.getElementById(`editSellerRow_${index}`);
  if (editRow) {
    editRow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); btnSave?.click(); }
      if (e.key === 'Escape') { e.preventDefault(); openSellerManager(); }
    });
  }
};

// Delete seller
window.deleteSeller = async function(index) {
  const sellers = getSellers();
  const seller = sellers[index];
  if (!seller) return;
  
  if (!(await confirmDialog({ title: '⚠️ Xóa người bán', message: `Bạn có chắc muốn xóa "${seller.name}"?`, danger: true }))) return;
  
  sellers.splice(index, 1);
  saveSellers(sellers);
  
  populateSellerDropdown();
  openSellerManager(); // Refresh modal
  showToast(`Đã xóa "${seller.name}"!`, 'success');
};
