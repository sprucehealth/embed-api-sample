import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class EmailTakenError extends Error {}

// The sample practice's own patient records, kept in one JSON file readable only by the current user.
export async function openStore(dir) {
  // Only a directory created here has its permissions set; one that already exists is left as its owner made it.
  if (await mkdir(dir, { recursive: true, mode: 0o700 })) await chmod(dir, 0o700);
  const file = path.join(dir, 'store.json');
  let data = { patients: [] };
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let queue = Promise.resolve();
  // Changes run one at a time against a copy that replaces the records in memory only once it is on disk, so a failed write changes nothing.
  // The file lands through a rename, so a crash never leaves it half-written.
  const mutate = (change) => {
    const run = queue
      .catch(() => {})
      .then(async () => {
        const next = structuredClone(data);
        const result = change(next);
        const tmp = file + '.tmp';
        await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(tmp, file);
        data = next;
        return structuredClone(result);
      });
    queue = run;
    return run;
  };

  const find = (predicate) => {
    const patient = data.patients.find(predicate);
    return patient ? structuredClone(patient) : null;
  };

  return {
    patientById: (id) => find((p) => p.id === id),
    patientByEmail: (email) => find((p) => p.email === email),
    patientByOrganizationId: (id) => find((p) => p.patientOrganizationId === id),
    listPatients: () => structuredClone(data.patients),
    // The email is checked inside the queued change, so two sign-ups sent together cannot both create the account.
    createPatient: (fields) =>
      mutate((next) => {
        if (next.patients.some((p) => p.email === fields.email)) throw new EmailTakenError();
        const patient = { id: randomUUID(), createdAt: new Date().toISOString(), ...fields };
        next.patients.push(patient);
        return patient;
      }),
    deletePatient: (id) =>
      mutate((next) => {
        next.patients = next.patients.filter((p) => p.id !== id);
      }),
    updatePatient: (id, fields) =>
      mutate((next) => {
        const patient = next.patients.find((p) => p.id === id);
        if (!patient) throw new Error('unknown patient');
        return Object.assign(patient, fields);
      }),
  };
}
