/* =========================================================================
 * Lumio Studio — WebRTC mesh
 *
 * A small full-mesh peer manager built on the "perfect negotiation" pattern
 * so camera/mic (and later screen) tracks can be added and renegotiated
 * without glare. Signaling rides the /rtc WebSocket; media is peer-to-peer.
 *
 * Events (via addEventListener):
 *   'ready'   → { id }                     own peer id assigned
 *   'brand'   → { brand }                  shared branding from host
 *   'roster'  → { roster }                 full presence list changed
 *   'stream'  → { id, kind, stream }       a remote cam/screen stream arrived
 *   'streamgone' → { id, kind }            a remote stream ended
 *   'leave'   → { id }                     a peer disconnected
 *   'chat'    → { from, name, text, ts }
 *   'kicked'  → {}                          host removed us
 *   'closed'  → {}                          signaling socket closed
 * ========================================================================= */

class MeshRTC extends EventTarget {
  constructor({ room, role, name }) {
    super();
    this.room = room;
    this.role = role;
    this.name = name;
    this.id = null;
    this.onstage = role === 'host';
    this.peers = new Map();          // remoteId -> { pc, polite, makingOffer, ignoreOffer }
    this.roster = [];
    this.localStream = null;         // camera + mic
    this.screenStream = null;        // optional screen share
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async connect(localStream) {
    this.localStream = localStream;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams({ room: this.room, role: this.role, name: this.name });
    this.ws = new WebSocket(`${proto}://${location.host}/rtc?${qs}`);

    this.ws.onmessage = ev => this._onSignal(JSON.parse(ev.data));
    this.ws.onclose = () => this.emit('closed', {});
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('Signaling connection failed.'));
    });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  /* ------------------------------ signaling ------------------------------ */

  async _onSignal(msg) {
    switch (msg.type) {
      case 'welcome':
        this.id = msg.id;
        this.onstage = msg.onstage;
        this.roster = msg.roster || [];
        this._publishStreamIds();
        this.emit('ready', { id: this.id });
        if (msg.brand) this.emit('brand', { brand: msg.brand });
        this.emit('roster', { roster: this.roster });
        // Existing peers initiate to us? No — we initiate to everyone already here.
        for (const p of this.roster) this._ensurePeer(p.id, true);
        break;

      case 'join':
        // A newcomer arrives; they will initiate to us, we just prepare.
        this._ensurePeer(msg.peer.id, false);
        this._mergeRoster(msg.peer);
        this.emit('roster', { roster: this.roster });
        break;

      case 'roster':
        this.roster = msg.roster;
        this.emit('roster', { roster: this.roster });
        break;

      case 'signal':
        await this._handleDescriptionOrCandidate(msg.from, msg.data);
        break;

      case 'brand': this.emit('brand', { brand: msg.brand }); break;
      case 'chat': this.emit('chat', msg); break;
      case 'leave': this._dropPeer(msg.id); this.emit('leave', { id: msg.id }); break;
      case 'kicked': this.emit('kicked', {}); break;
    }
  }

  _mergeRoster(peer) {
    const i = this.roster.findIndex(p => p.id === peer.id);
    if (i >= 0) this.roster[i] = peer; else this.roster.push(peer);
  }

  /* ------------------------------ peers ------------------------------ */

  _ensurePeer(remoteId, initiator) {
    if (remoteId === this.id || this.peers.has(remoteId)) return this.peers.get(remoteId);

    const polite = this.id < remoteId; // deterministic, opposite on each side
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const rec = { pc, polite, makingOffer: false, ignoreOffer: false };
    this.peers.set(remoteId, rec);

    // Publish local tracks.
    for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);
    if (this.screenStream) for (const t of this.screenStream.getVideoTracks()) pc.addTrack(t, this.screenStream);

    pc.onnegotiationneeded = async () => {
      try {
        rec.makingOffer = true;
        await pc.setLocalDescription();
        this._send({ type: 'signal', to: remoteId, data: { description: pc.localDescription } });
      } catch (e) { /* ignore */ } finally { rec.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._send({ type: 'signal', to: remoteId, data: { candidate } });
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0];
      if (!stream) return;
      const kind = this._classifyStream(remoteId, stream.id, track);
      const fire = () => this.emit('stream', { id: remoteId, kind, stream });
      fire();
      stream.onremovetrack = () => { if (!stream.getTracks().length) this.emit('streamgone', { id: remoteId, kind }); };
      track.onended = () => this.emit('streamgone', { id: remoteId, kind });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this._dropPeer(remoteId);
    };
    return rec;
  }

  /** Decide whether an incoming stream is a peer's camera or their screen. */
  _classifyStream(remoteId, streamId, track) {
    const meta = this.roster.find(p => p.id === remoteId);
    if (meta && meta.screenStreamId && streamId === meta.screenStreamId) return 'screen';
    if (track.kind === 'audio') return 'camera';
    return 'camera';
  }

  async _handleDescriptionOrCandidate(remoteId, data) {
    const rec = this._ensurePeer(remoteId, false);
    const { pc } = rec;
    try {
      if (data.description) {
        const offerCollision = data.description.type === 'offer'
          && (rec.makingOffer || pc.signalingState !== 'stable');
        rec.ignoreOffer = !rec.polite && offerCollision;
        if (rec.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this._send({ type: 'signal', to: remoteId, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!rec.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('signal error', e); }
  }

  _dropPeer(remoteId) {
    const rec = this.peers.get(remoteId);
    if (!rec) return;
    try { rec.pc.close(); } catch { /* ok */ }
    this.peers.delete(remoteId);
  }

  /* ------------------------------ local media ------------------------------ */

  /** Add/replace the screen share track across all peers (renegotiates). */
  async setScreenStream(stream) {
    this.screenStream = stream;
    for (const [, rec] of this.peers) {
      if (stream) for (const t of stream.getVideoTracks()) rec.pc.addTrack(t, stream);
    }
    this._publishStreamIds();
  }

  async removeScreenStream() {
    if (!this.screenStream) return;
    const ids = new Set(this.screenStream.getTracks().map(t => t.id));
    for (const [, rec] of this.peers) {
      rec.pc.getSenders().filter(s => s.track && ids.has(s.track.id))
        .forEach(s => { try { rec.pc.removeTrack(s); } catch { /* ok */ } });
    }
    this.screenStream = null;
    this._publishStreamIds();
  }

  _publishStreamIds() {
    this._send({
      type: 'state',
      camStreamId: this.localStream ? this.localStream.id : null,
      screenStreamId: this.screenStream ? this.screenStream.id : null,
    });
  }

  /* ------------------------------ presence / control ------------------------------ */

  setState({ mic, cam }) {
    const p = {};
    if (mic !== undefined) p.mic = mic;
    if (cam !== undefined) p.cam = cam;
    this._send({ type: 'state', ...p });
  }
  setStage(id, onstage) { this._send({ type: 'stage', id, onstage }); }
  kick(id) { this._send({ type: 'kick', id }); }
  sendChat(text) { this._send({ type: 'chat', text }); }
  setBrand(brand) { this._send({ type: 'brand', brand }); }

  close() { try { this.ws.close(); } catch { /* ok */ } for (const id of [...this.peers.keys()]) this._dropPeer(id); }
}

window.MeshRTC = MeshRTC;
