import { createApp } from './app.js';
import { loadConfig, promptLine } from './config.js';
import { createPracticeClient } from './spruce/practice.js';
import { SpruceError } from './spruce/request.js';
import { openStore } from './store.js';

// Picks the Spruce Link that will own each patient's secure conversation.
async function chooseInternalEndpoint(practice, configuredId) {
  const links = (await practice.internalEndpoints()).filter((entry) => entry.endpoint?.channel === 'secure');
  if (configuredId) {
    const match = links.find((entry) => entry.endpoint.id === configuredId);
    if (!match) throw new Error('SPRUCE_INTERNAL_ENDPOINT_ID does not match any Spruce Link of this organization.');
    return match.endpoint;
  }
  if (links.length === 0) throw new Error('This organization has no Spruce Link. Create one in Spruce, then start again.');
  if (links.length === 1) return links[0].endpoint;
  console.log('\nThis organization has several Spruce Links. Which one should own patient conversations?');
  links.forEach((entry, index) => {
    const label = entry.endpoint.label ? ` (${entry.endpoint.label})` : '';
    console.log(`  ${index + 1}. ${entry.endpoint.displayValue}${label}`);
  });
  const answer = Number(await promptLine(`Choose 1-${links.length}: `));
  if (!Number.isInteger(answer) || answer < 1 || answer > links.length) throw new Error('That is not one of the choices.');
  return links[answer - 1].endpoint;
}

async function main() {
  const config = await loadConfig({ argv: process.argv.slice(2) });
  console.log(`Public API: ${config.apiUrl}`);
  console.log(`Embed host: ${config.embedUrl}`);

  const practice = createPracticeClient({ baseUrl: config.apiUrl, credential: config.credential });
  let organization;
  try {
    organization = await practice.organization();
  } catch (err) {
    if (err instanceof SpruceError && err.status === 403) {
      throw new Error('Spruce refused the API token (403). Check the token and that it belongs to the environment above.');
    }
    if (!(err instanceof SpruceError)) throw new Error(`The Public API at ${config.apiUrl} could not be reached.`);
    throw err;
  }
  const endpoint = await chooseInternalEndpoint(practice, config.internalEndpointId);
  const store = await openStore(config.dataDir);
  const app = createApp({ config, store, practice, organization, internalEndpointId: endpoint.id });
  await app.listen(config.port);

  console.log(`\nPractice:    ${organization.name}`);
  console.log(`Spruce Link: ${endpoint.displayValue}`);
  console.log(`\nPatient portal:    ${app.origin()}/`);
  console.log(`Webhook simulator: ${app.origin()}/dev/`);
  console.log('\nPress Ctrl+C to stop.\n');

  const stop = () => app.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err) => {
  // Only the message is printed, so a stack trace can never carry request headers to the terminal.
  const detail = err instanceof SpruceError ? `Spruce answered ${err.status}: ${err.message}` : err.message;
  console.error(`\nCould not start: ${detail}`);
  process.exit(1);
});
