import { escapeHtml, showToast } from '../../ui-renderer.js';
import { getBrandPrefixes, saveBrandPrefixes, DEFAULT_BRAND_PREFIXES } from '../seller/manager.js';
import { confirmDialog } from '../ui/confirm-dialog.js';

// =========================================================================
//  PREFIX MANAGEMENT UI
// =========================================================================

// Render prefix config list in settings panel
export function renderPrefixConfigList() {
  const container = document.getElementById('prefixConfigList');
  if (!container) return;
  
  const prefixes = getBrandPrefixes();
  const brands = Object.keys(prefixes);
  
  if (brands.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Chưa có prefix nào được cấu hình</p>';
    return;
  }
  
  container.innerHTML = brands.map(brand => `
    <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg-tertiary); border-radius: var(--radius-sm);">
      <div style="flex: 1;">
        <div style="font-weight: 500; color: var(--text-primary); text-transform: capitalize;">${escapeHtml(brand)}</div>
      </div>
      <input type="text" 
        value="${escapeHtml(prefixes[brand])}" 
        data-brand="${escapeHtml(brand)}"
        class="prefix-input"
        placeholder="Prefix"
        style="width: 150px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem; font-family: monospace;">
      <button onclick="updateBrandPrefix('${escapeHtml(brand)}')" 
        style="padding: 8px 16px; background: var(--accent-green); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;">💾 Lưu</button>
      <button onclick="deleteBrandPrefix('${escapeHtml(brand)}')" 
        style="padding: 8px 12px; background: var(--accent-red); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;">🗑️</button>
    </div>
  `).join('');
}

// Update brand prefix
window.updateBrandPrefix = function(brand) {
  const input = document.querySelector(`.prefix-input[data-brand="${brand}"]`);
  if (!input) return;
  
  const newPrefix = input.value.trim();
  if (!newPrefix) {
    showToast('Prefix không được để trống!', 'error');
    return;
  }
  
  const prefixes = getBrandPrefixes();
  prefixes[brand] = newPrefix;
  saveBrandPrefixes(prefixes);
  
  showToast(`Đã cập nhật prefix cho "${brand}": ${newPrefix}`, 'success');
};

// Delete brand prefix
window.deleteBrandPrefix = async function(brand) {
  if (!(await confirmDialog({ title: '⚠️ Xóa prefix', message: `Bạn có chắc muốn xóa prefix của "${brand}"?`, danger: true }))) return;
  
  const prefixes = getBrandPrefixes();
  delete prefixes[brand];
  saveBrandPrefixes(prefixes);
  
  renderPrefixConfigList();
  renderSequenceResetList();
  showToast(`Đã xóa prefix của "${brand}"!`, 'success');
};

// Add new brand prefix
export async function addBrandPrefix() {
  const brand = prompt('Nhập tên loại hàng (chữ thường, không dấu, VD: zentor, xvil):');
  if (!brand) return;
  
  const cleanBrand = brand.toLowerCase().trim();
  if (!cleanBrand) {
    showToast('Tên loại hàng không hợp lệ!', 'error');
    return;
  }
  
  const prefixes = getBrandPrefixes();
  if (prefixes[cleanBrand]) {
    // Trùng loại hàng: hỏi có muốn cập nhật prefix hay không (variant thường)
    if (!(await confirmDialog({ title: 'Prefix đã tồn tại', message: `Loại hàng "${cleanBrand}" đã tồn tại. Bạn có muốn cập nhật prefix?` }))) return;
  }
  
  const prefix = prompt(`Nhập prefix cho "${cleanBrand}":`, DEFAULT_BRAND_PREFIXES[cleanBrand] || '');
  if (prefix === null) return; // Cancelled
  
  const cleanPrefix = prefix.trim();
  if (!cleanPrefix) {
    showToast('Prefix không được để trống!', 'error');
    return;
  }
  
  prefixes[cleanBrand] = cleanPrefix;
  saveBrandPrefixes(prefixes);
  
  renderPrefixConfigList();
  renderSequenceResetList();
  showToast(`Đã thêm prefix cho "${cleanBrand}": ${cleanPrefix}`, 'success');
}

// Reset all prefixes to defaults
export async function resetPrefixesToDefault() {
  if (!(await confirmDialog({ title: 'Khôi phục prefix mặc định', message: 'Bạn có chắc muốn khôi phục tất cả prefix về mặc định?', danger: true }))) return;
  
  saveBrandPrefixes({ ...DEFAULT_BRAND_PREFIXES });
  renderPrefixConfigList();
  renderSequenceResetList();
  showToast('Đã khôi phục prefix mặc định!', 'success');
}

// Render sequence reset list
export function renderSequenceResetList() {
  const container = document.getElementById('sequenceResetList');
  if (!container) return;
  
  const prefixes = getBrandPrefixes();
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  
  const brands = Object.keys(prefixes);
  
  if (brands.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Chưa có loại hàng nào</p>';
    return;
  }
  
  container.innerHTML = brands.map(brand => {
    const prefix = prefixes[brand];
    const seqKey = `orderSeq_${prefix}_${yy}${mm}`;
    const currentSeq = localStorage.getItem(seqKey) || '0';
    
    return `
      <div style="display: flex; align-items: center; gap: 12px; padding: 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm);">
        <div style="flex: 1;">
          <div style="font-weight: 500; color: var(--text-primary); text-transform: capitalize;">${escapeHtml(brand)}</div>
          <div style="font-size: 0.85rem; color: var(--text-secondary);">STT hiện tại: <strong>${currentSeq}</strong> — đơn tiếp theo: <strong>${String(Number(currentSeq) + 1).padStart(2, '0')}</strong></div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="number" id="seqInput_${escapeHtml(brand)}" value="${currentSeq}" min="0" style="width: 60px; padding: 5px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-size: 0.85rem; text-align: center;">
          <button onclick="setBrandSequence('${escapeHtml(brand)}')" 
            style="padding: 6px 12px; background: var(--accent-yellow); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">✏️ Đặt STT</button>
        </div>
      </div>
    `;
  }).join('');
}

// Set sequence for a specific brand to a custom value
window.setBrandSequence = function(brand) {
  const prefixes = getBrandPrefixes();
  const prefix = prefixes[brand];
  if (!prefix) return;
  
  const input = document.getElementById(`seqInput_${brand}`);
  const val = parseInt(input?.value);
  if (isNaN(val) || val < 0) {
    showToast('Số không hợp lệ!', 'error');
    return;
  }
  
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const seqKey = `orderSeq_${prefix}_${yy}${mm}`;
  
  localStorage.setItem(seqKey, String(val));
  renderSequenceResetList();
  showToast(`Đã đặt STT của "${brand}" = ${val}. Đơn tiếp theo sẽ là ${String(val + 1).padStart(2, '0')}.`, 'success');
};
