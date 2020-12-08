import * as Promise from 'bluebird';
import { runPatcher } from 'harmony-patcher';
import * as path from 'path';
import { actions, fs, log, selectors, types, util } from 'vortex-api';

import { FAKE_FILE, IDeployment, IGameStoredInfo, IPatcherDetails, ISortedEntries } from './types';

import ensureHarmonyMod from './harmonymod';

const MODULE_PATH = path.join(util.getVortexPath('modules_unpacked'), 'harmony-patcher', 'dist');
const DEFAULT_UNITY_ASSEMBLY: string = 'Assembly-CSharp.dll';

// The Harmony patcher modtype relies on game extensions to provide it with all
//  the required information to attempt to run the harmony patcher
//  automatically. This can be done using the details object when
//  registering a game e.g. registerGame(... details: { harmonyPatchDetails: { ... } }).
const DETAILS_PATCH_TARGET: string = 'harmonyPatchDetails';

function getCurrentGameInfo(context: types.IExtensionContext): IGameStoredInfo {
  const state: any = context.api.store.getState();
  if (state === undefined) {
    return undefined;
  }

  const profile: types.IProfile = selectors.activeProfile(state);
  const game: types.IGameStored = selectors.currentGame(state);
  if (game === undefined || (game.id !== profile?.gameId)) {
    return undefined;
  }

  const discovery: types.IDiscoveryResult = util.getSafe(state,
    ['settings', 'gameMode', 'discovered', game.id], undefined);

  if (discovery?.path === undefined) {
      return undefined;
  }

  return { game, discoveryPath: discovery.path };
}

function test(instructions: types.IInstruction[],
              context: types.IExtensionContext): Promise<boolean> {
  const gameInfo = getCurrentGameInfo(context);
  if (gameInfo === undefined) {
    return Promise.resolve(false);
  }

  const patcherDetails: IPatcherDetails = getPatcherDetails(gameInfo.game);
  if (patcherDetails === undefined) {
    return Promise.resolve(false);
  }

  const filtered = instructions.filter(instr => !!instr?.source);
  const isHarmonyPatcherMod = filtered.find((instr: types.IInstruction) =>
    instr.source.indexOf(FAKE_FILE) !== -1) !== undefined;

  return Promise.resolve(isHarmonyPatcherMod);
}

function getPatcherDetails(game: types.IGame | types.IGameStored): IPatcherDetails {
  if (!!game.details && !!game.details[DETAILS_PATCH_TARGET]) {
    try {
      const stringified: string = JSON.stringify(game.details[DETAILS_PATCH_TARGET]);
      const patchDetails: IPatcherDetails = JSON.parse(stringified);
      patchDetails.dataPath = (!patchDetails.dataPath.endsWith('.dll'))
        ? path.join(patchDetails.dataPath, DEFAULT_UNITY_ASSEMBLY)
        : patchDetails.dataPath;

      return patchDetails;
    } catch (err) {
      log('error', 'invalid patcher details provided', err);
    }
  }
  return undefined;
}

function merge(filePath: string,
               mergeDir: string,
               context: types.IExtensionContext): Promise<void> {
  const gameInfo = getCurrentGameInfo(context);
  if (gameInfo === undefined) {
    // How the heck is this possible ?
    return Promise.reject(new util.NotFound('Not actively managing any game'));
  }

  // We don't want to replace any pre-existing libraries which the game is using.
  //  getGameAssemblies will return only non-symlinks.
  const getGameAssemblies = (unityDataPath: string): Promise<string[]> => {
    return fs.readdirAsync(unityEnginePath)
      .then((entries: string[]) => {
        const filtered = entries.filter(entry => entry.endsWith('.dll'));
        return Promise.reduce(filtered, (accumulator, entry) => {
          return fs.lstatAsync(path.join(unityDataPath, entry))
            .then(stats => {
              if (!stats.isSymbolicLink()) {
                accumulator.push(entry);
              }
              return accumulator;
            })
            .catch(err => accumulator);
        }, []);
      });
  };

  const deployAssemblies = (relDataPath: string, unityDataPath: string) => {
    relDataPath = relDataPath.endsWith('.dll') ? path.dirname(relDataPath) : relDataPath;
    const assemblyPath = path.join(mergeDir, relDataPath);
    return Promise.all([fs.readdirAsync(MODULE_PATH),
                        fs.readdirAsync(assemblyPath),
                        getGameAssemblies(unityDataPath)])
      .then((res) => {
        // Filter for: any dll file which isn't a system dll EXCEPT
        //  the runtime serialization dll which is used by our json
        //  parsing lib.
        const modulePathAssemblies: string[] = res[0].filter(x =>
                      (x.endsWith('.dll') && !x.startsWith('System'))
                   || (x === 'System.Runtime.Serialization.dll'));

        const diff: string[] = (modulePathAssemblies.filter(x => !res[1].includes(x)
                                                              && !res[2].includes(x)));
        return Promise.resolve(diff);
      })
      .then(assemblies => {
        const copiedAssemblies: string[] = [];
        return Promise.each(assemblies || [], assembly =>
          fs.copyAsync(path.join(MODULE_PATH, assembly),
                       path.join(mergeDir, relDataPath, assembly))
            .tap(() => copiedAssemblies.push(path.join(mergeDir, relDataPath, assembly))))
        .catch(err => {
          // We were not able to copy over the required assemblies.
          //  Cleanup might be needed.
          log('error', 'failed to copy required Harmony patcher assembly', err.message);
          return Promise.each(copiedAssemblies, assembly => fs.removeAsync(assembly))
            .then(() => Promise.reject(err)) // Cleanup successful, error still needs forwarding
            .catch(err2 => {
              // Cleanup failed
              log('warn', 'failed to clean up copied assemblies', err2.message);
              return Promise.reject(err);
            });
        });
      });
  };

  const patcherDetails: IPatcherDetails = getPatcherDetails(gameInfo.game);
  const dataPath: string = path.join(gameInfo.discoveryPath, patcherDetails.dataPath);
  const modsPath: string = path.join(gameInfo.discoveryPath, patcherDetails.modsPath);
  const mergedFilePath: string = path.join(mergeDir, patcherDetails.dataPath);
  const unityEnginePath: string = dataPath.endsWith('.dll') ? path.dirname(dataPath) : dataPath;
  return fs.statAsync(mergedFilePath)
    .then(() => deployAssemblies(patcherDetails.dataPath, unityEnginePath))
    .then(() => runPatcher(gameInfo.game.extensionPath,
                           mergedFilePath,
                           patcherDetails.entryPoint,
                           false,
                           modsPath,
                           context as any,
                           patcherDetails.injectVIGO,
                           unityEnginePath))
    .catch(err => (err instanceof util.UserCanceled)
      ? Promise.resolve()
      : Promise.reject(err));
}

function canMerge(game: types.IGame, gameDiscovery: types.IDiscoveryResult): types.IMergeFilter {
  const patcherDetails: IPatcherDetails = getPatcherDetails(game);
  return (patcherDetails === undefined)
    ? undefined
    : ({
      baseFiles: () => [
        {
          in: path.join(gameDiscovery.path, patcherDetails.dataPath),
          out: patcherDetails.dataPath,
        },
      ],
      filter: filePath => filePath.indexOf(FAKE_FILE) !== -1,
    });
}

function getDiscoveryPath(context: types.IExtensionContext, gameId: string): string {
  const store: types.ThunkStore<any> = context.api.store;
  const state: any = store.getState();
  const discovery: types.IDiscoveryResult = util.getSafe(state,
    ['settings', 'gameMode', 'discovered', gameId], undefined);
  return (!!discovery && !!discovery.path)
    ? discovery.path : undefined;
}

function init(context: types.IExtensionContext) {
  const isHarmonyPatcherGame = (gameId: string) => {
    const gameInfo = getCurrentGameInfo(context);
    if (gameInfo === undefined) {
      // How the heck is this possible ?
      return false;
    }

    const patcherDetails: IPatcherDetails = getPatcherDetails(gameInfo.game);
    return (patcherDetails !== undefined);
  };

  const getPath = (game: types.IGame) => {
    const discoveryPath: string = getDiscoveryPath(context, game.id);
    return (discoveryPath !== undefined) ? discoveryPath : undefined;
  };

  context.registerModType('harmonypatchermod', 25, isHarmonyPatcherGame, getPath,
    (instructions: types.IInstruction[]) => test(instructions, context));

  context.registerMerge(canMerge,
    (filePath: string, mergeDir: string) =>
      merge(filePath, mergeDir, context), 'harmonypatchermod');

  context.once(() => {
    context.api.onAsync('will-deploy', (profileId: string, deployment: IDeployment) => {
      const state: types.IState = context.api.store.getState();
      const profile = state.persistent.profiles[profileId];
      const gameInfo = getCurrentGameInfo(context);
      if (gameInfo === undefined) {
        return Promise.resolve();
      }

      const patcherDetails: IPatcherDetails = getPatcherDetails(gameInfo.game);
      if (patcherDetails === undefined) {
        return Promise.resolve();
      }

      return new Promise(resolve => ensureHarmonyMod(context.api, profile)
        .then(modId => {
          if ((util.getSafe(state, ['mods', modId], undefined) !== undefined)
            && !util.getSafe(profile, ['modState', modId, 'enabled'], true)) {
            // if the data mod is known but disabled, don't update it and most importantly:
            //  don't activate it after deployment, that's probably not what the user wants
            return resolve();
          }

          context.api.store.dispatch(actions.setModEnabled(profile.id, modId, true));
          return resolve();
        }));
    });
  });

  return true;
}

export default init;
