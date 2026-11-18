import { HttpError, readJson, sendJson } from '../http.js';
import { SIMULATED_EVENTS } from '../simulator.js';

// Routes behind the developer utility at /dev/. They need no patient session and rely on the loopback bind and the Host and Origin checks.
export function registerDevRoutes(router, { store, gateway, simulator }) {
  router.add('GET', '/dev/api/state', async (ctx) => {
    sendJson(ctx.res, 200, {
      eventTypes: SIMULATED_EVENTS,
      patients: store
        .listPatients()
        .filter((patient) => patient.patientOrganizationId)
        .map((patient) => ({
          id: patient.id,
          name: `${patient.givenName} ${patient.familyName}`,
          email: patient.email,
          patientOrganizationId: patient.patientOrganizationId,
          online: Boolean(gateway.liveActor(patient.id)),
        })),
    });
  });

  router.add('GET', '/dev/api/patients/:patientId/items', async (ctx) => {
    sendJson(ctx.res, 200, { items: await simulator.listItems(ctx.params.patientId) });
  });

  router.add('POST', '/dev/api/simulate', async (ctx) => {
    const body = await readJson(ctx.req);
    for (const field of ['patientId', 'type', 'itemId']) {
      if (typeof body[field] !== 'string' || body[field] === '') throw new HttpError(400, 'invalid_input', `${field} is required.`);
    }
    sendJson(ctx.res, 200, await simulator.send(body));
  });
}
