import * as path from 'path';
import { actions, fs, log, selectors, types, util } from 'vortex-api';

import { FAKE_FILE } from './types';

// most of these are invalid on windows only but it's not worth the effort allowing them elsewhere
const INVALID_CHARS = /[:/\\*?"<>|]/g;

function sanitizeProfileName(input: string) {
  return input.replace(INVALID_CHARS, '_');
}

export function harmonyDataMod(profileName: string): string {
  return `Vortex Harmony Mod (${sanitizeProfileName(profileName)})`;
}

async function createHarmonyMod(api: types.IExtensionApi,
                                modName: string, profile: types.IProfile): Promise<void> {
  const mod: types.IMod = {
    id: modName,
    state: 'installed',
    attributes: {
      name: 'Vortex Harmony Mod',
      logicalFileName: 'Vortex Harmony Mod',
      // concrete id doesn't really matter but needs to be set to for grouping
      modId: 42,
      version: '1.0.0',
      variant: sanitizeProfileName(profile.name.replace(INVALID_CHARS, '_')),
      installTime: new Date(),
    },
    installationPath: modName,
    type: 'harmonypatchermod',
  };

  await new Promise<void>((resolve, reject) => {
    api.events.emit('create-mod', profile.gameId, mod, async (error) => {
      if (error !== null) {
        return reject(error);
      }
      resolve();
    });
  });

  const state = api.store.getState();
  const installPath = (selectors as any).installPathForGame(state, profile.gameId);

  await fs.ensureFileAsync(path.join(installPath, modName, FAKE_FILE));
}

// tslint:disable-next-line: max-line-length
async function ensureHarmonyMod(api: types.IExtensionApi, profile: types.IProfile): Promise<string> {
  const state: types.IState = api.store.getState();
  const modName = harmonyDataMod(profile.name);
  const mod = util.getSafe(state, ['persistent', 'mods', profile.gameId, modName], undefined);
  if (mod === undefined) {
    await createHarmonyMod(api, modName, profile);
  } else {
    // give the user an indication when this was last updated
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'installTime', new Date()));
    // the rest here is only required to update mods from previous vortex versions
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName,
                                               'name', 'Vortex Harmony Mod'));

    api.store.dispatch(actions.setModAttribute(profile.gameId, modName,
                                               'type', 'harmonypatchermod'));

    api.store.dispatch(actions.setModAttribute(profile.gameId, modName,
                                               'logicalFileName', 'Vortex Harmony Mod'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'modId', 42));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'version', '1.0.0'));
    api.store.dispatch(actions.setModAttribute(profile.gameId, modName, 'variant',
                                               sanitizeProfileName(profile.name)));
  }
  return modName;
}

export default ensureHarmonyMod;
