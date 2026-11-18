// Fans events out to every open browser stream of one patient using server-sent events.
export function createEventHub({ heartbeatMs = 25000 } = {}) {
  const streams = new Map();

  // A stream leaves the list the moment it is ended, so nothing can write to it afterwards.
  function drop(patientId, stream) {
    clearInterval(stream.heartbeat);
    const set = streams.get(patientId);
    if (!set?.delete(stream)) return;
    if (set.size === 0) streams.delete(patientId);
  }

  function end(patientId, stream) {
    drop(patientId, stream);
    if (!stream.res.writableEnded) stream.res.end();
  }

  const open = (res) => !res.writableEnded && !res.destroyed;

  function closeWhere(patientId, matches) {
    for (const stream of [...(streams.get(patientId) ?? [])]) if (matches(stream)) end(patientId, stream);
  }

  return {
    // The stream belongs to the session that opened it and ends at that session's expiry.
    subscribe(patientId, req, res, { sessionId, until }) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const stream = { res, sessionId };
      const set = streams.get(patientId) ?? new Set();
      streams.set(patientId, set);
      set.add(stream);
      stream.heartbeat = setInterval(() => {
        if (open(res) && Date.now() < until) res.write(': keep-alive\n\n');
        else end(patientId, stream);
      }, heartbeatMs);
      stream.heartbeat.unref();
      const gone = () => drop(patientId, stream);
      req.on('close', gone);
      res.on('close', gone);
      // A write that fails on a broken connection is reported here; without a listener it would stop the process.
      res.on('error', gone);
    },
    publish(patientId, event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const stream of streams.get(patientId) ?? []) if (open(stream.res)) stream.res.write(payload);
    },
    // Ends the streams one session opened; the patient's other browsers keep theirs.
    closeSession(patientId, sessionId) {
      closeWhere(patientId, (stream) => stream.sessionId === sessionId);
    },
    closePatient(patientId) {
      closeWhere(patientId, () => true);
    },
    closeAll() {
      for (const patientId of [...streams.keys()]) closeWhere(patientId, () => true);
    },
  };
}
