/* =========================================================================
 * Lumio — shared client helpers
 *
 * LumioSignal : thin wrapper around the /ws signaling socket
 * LumioMesh   : full-mesh WebRTC between studio participants (host+guests),
 *               using the "perfect negotiation" pattern so cam + screen
 *               tracks can be added/removed at any time without glare.
 * ========================================================================= */
(() => {
  'use strict';

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  /* ------------------------------ signaling ------------------------------ */

  class LumioSignal {
    constructor() {
      this.handlers = new Map();
      this.ws = null;
      this.closedByUs = false;
    }

    connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws.onmessage = ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        const h = this.handlers.get(msg.type);
        if (h) h(msg);
      };
      this.ws.onclose = () => {
        if (!this.closedByUs) {
          const h = this.handlers.get('_disconnected');
          if (h) h({});
        }
      };
      return new Promise((resolve, reject) => {
        this.ws.onopen = resolve;
        this.ws.onerror = () => reject(new Error('Could not reach the Lumio server.'));
      });
    }

    on(type, fn) { this.handlers.set(type, fn); }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }

    close() { this.closedByUs = true; try { this.ws.close(); } catch { /* ok */ } }
  }

  /* -------------------------------- mesh -------------------------------- */

  /**
   * options:
   *   signal        LumioSignal (already joined)
   *   selfId        our peerId
   *   getLocalTracks() -> [{track, stream}]  everything we currently send
   *   onTrack(peerId, track, stream)
   *   onPeerClosed(peerId)
   */
  class LumioMesh {
    constructor(opts) {
      this.o = opts;
      this.peers = new Map(); // peerId -> { pc, makingOffer, ignoreOffer, polite }
    }

    /** Open a connection to a peer. Existing peers call this when someone
     *  joins; the joiner calls it for everyone already in the room. */
    ensurePeer(peerId) {
      if (this.peers.has(peerId)) return this.peers.get(peerId);

      const polite = this.o.selfId > peerId; // deterministic tie-break
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const entry = { pc, makingOffer: false, ignoreOffer: false, polite };
      this.peers.set(peerId, entry);

      for (const { track, stream } of this.o.getLocalTracks()) {
        pc.addTrack(track, stream);
      }

      pc.onnegotiationneeded = async () => {
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription();
          this.o.signal.send({ type: 'rtc', to: peerId, data: { description: pc.localDescription } });
        } catch (e) {
          console.warn('negotiation failed', e);
        } finally {
          entry.makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        this.o.signal.send({ type: 'rtc', to: peerId, data: { candidate } });
      };

      pc.ontrack = ev => {
        const stream = ev.streams[0] || new MediaStream([ev.track]);
        this.o.onTrack(peerId, ev.track, stream);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          try { pc.restartIce(); } catch { /* ok */ }
        }
      };

      return entry;
    }

    async handleSignal(from, data) {
      const entry = this.ensurePeer(from);
      const { pc } = entry;
      try {
        if (data.description) {
          const desc = data.description;
          const collision = desc.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
          entry.ignoreOffer = !entry.polite && collision;
          if (entry.ignoreOffer) return;
          await pc.setRemoteDescription(desc);
          if (desc.type === 'offer') {
            await pc.setLocalDescription();
            this.o.signal.send({ type: 'rtc', to: from, data: { description: pc.localDescription } });
          }
        } else if (data.candidate !== undefined) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (e) {
            if (!entry.ignoreOffer) throw e;
          }
        }
      } catch (e) {
        console.warn('rtc signal error', e);
      }
    }

    /** Add a track to every peer connection (e.g. starting screen share). */
    addTrackToAll(track, stream) {
      for (const { pc } of this.peers.values()) pc.addTrack(track, stream);
    }

    /** Remove a track (by its sender) from every peer connection. */
    removeTrackFromAll(track) {
      for (const { pc } of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track === track);
        if (sender) { try { pc.removeTrack(sender); } catch { /* ok */ } }
      }
    }

    /** Swap the outgoing camera/mic track in place (device change). */
    async replaceTrackAll(kind, newTrack) {
      for (const { pc } of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === kind);
        if (sender) await sender.replaceTrack(newTrack);
      }
    }

    closePeer(peerId) {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      this.peers.delete(peerId);
      try { entry.pc.close(); } catch { /* ok */ }
      this.o.onPeerClosed(peerId);
    }

    closeAll() {
      for (const peerId of [...this.peers.keys()]) this.closePeer(peerId);
    }
  }

  /* ------------------------------ utilities ------------------------------ */

  const LumioUtil = {
    roomIdFromPath() {
      const m = location.pathname.match(/\/(?:studio|guest|watch)\/([a-z0-9]{10})/);
      return m ? m[1] : null;
    },

    escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]);
    },

    fmtTime(ts) {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    /* Chrome quirk: a remote WebRTC audio track only produces data for the
     * Web Audio API once it is attached to a media element. */
    primeAudio(stream) {
      const a = new Audio();
      a.srcObject = stream;
      a.muted = true;
      a.play().catch(() => { /* autoplay may need a gesture; harmless */ });
      return a;
    },
  };

  window.LumioSignal = LumioSignal;
  window.LumioMesh = LumioMesh;
  window.LumioUtil = LumioUtil;
})();
