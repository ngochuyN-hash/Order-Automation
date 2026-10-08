// --- Simple debounce utility ---
export function debounce(fn, delay) {
  let timer = null;
  const debounced = function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
  // Hủy lần gọi đang chờ (VD: user đã chọn gợi ý trước khi timer debounce nổ)
  debounced.cancel = function() {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
