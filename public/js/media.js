/* =========================================================================
 * Lumio Studio — shared media/device helpers
 * ========================================================================= */

const LumioMedia = (() => {
  'use strict';

  async function populateDevices(camSel, micSel) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      probe.getTracks().forEach(t => t.stop());
    } catch { /* labels may stay generic if denied */ }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, fallback) => {
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = '';
      devs.filter(d => d.kind === kind).forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `${fallback} ${i + 1}`;
        sel.appendChild(o);
      });
      if (!sel.options.length) sel.innerHTML = `<option value="">No ${fallback.toLowerCase()} found</option>`;
      if (prev) sel.value = prev;
    };
    fill(camSel, 'videoinput', 'Camera');
    fill(micSel, 'audioinput', 'Microphone');
  }

  async function getStream(camId, micId) {
    return navigator.mediaDevices.getUserMedia({
      video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  return { populateDevices, getStream };
})();

window.LumioMedia = LumioMedia;
