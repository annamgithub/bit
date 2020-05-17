import * as path from 'path';
import * as fs from 'fs-extra';
import { omit } from 'ramda';
import { parse, stringify, assign } from 'comment-json';
import LegacyWorkspaceConfig, {
  WorkspaceConfigProps as LegacyWorkspaceConfigProps
} from '../../consumer/config/workspace-config';
import ConsumerOverrides, { ConsumerOverridesOfComponent } from '../../consumer/config/consumer-overrides';
import { WORKSPACE_JSONC, DEFAULT_LANGUAGE, COMPILER_ENV_TYPE } from '../../constants';
import { PathOsBased, PathOsBasedAbsolute } from '../../utils/path';
import InvalidConfigFile from './exceptions/invalid-config-file';
import DataToPersist from '../../consumer/component/sources/data-to-persist';
import { AbstractVinyl } from '../../consumer/component/sources';
import { Compilers, Testers } from '../../consumer/config/abstract-config';

import { EnvType } from '../../legacy-extensions/env-extension-types';
import { isFeatureEnabled } from '../../api/consumer/lib/feature-toggle';
import logger from '../../logger/logger';
import { InvalidBitJson } from '../../consumer/config/exceptions';
import { ILegacyWorkspaceConfig, ExtensionConfigList, ExtensionConfigEntry } from '../../consumer/config';
import { ResolveModulesConfig } from '../../consumer/component/dependencies/files-dependency-builder/types/dependency-tree-type';
import { HostConfig } from './types';

const INTERNAL_CONFIG_PROPS = ['$schema', '$schemaVersion'];

export type LegacyInitProps = {
  standAlone?: boolean;
};

export type WorkspaceConfigFileProps = {
  // TODO: make it no optional
  $schema?: string;
  $schemaVersion?: string;
} & ExtensionsDefs;

export type ComponentScopeDirMapEntry = {
  defaultScope?: string;
  directory: string;
};

export type ComponentScopeDirMap = Array<ComponentScopeDirMapEntry>;

export type WorkspaceExtensionProps = {
  defaultOwner?: string;
  defaultScope?: string;
  defaultDirectory?: string;
  components?: ComponentScopeDirMap;
};

export type PackageManagerClients = 'librarian' | 'npm' | 'yarn' | undefined;

export interface DependencyResolverExtensionProps {
  packageManager: PackageManagerClients;
  strictPeerDependencies?: boolean;
  extraArgs?: string[];
  packageManagerProcessOptions?: any;
  useWorkspaces?: boolean;
  manageWorkspaces?: boolean;
}

export type WorkspaceSettingsNewProps = {
  '@teambit/workspace': WorkspaceExtensionProps;
  '@teambit/dependency-resolver': DependencyResolverExtensionProps;
};

export type WorkspaceLegacyProps = {
  dependenciesDirectory?: string;
  bindingPrefix?: string;
  resolveModules?: ResolveModulesConfig;
  saveDependenciesAsComponents?: boolean;
  distEntry?: string;
  distTarget?: string;
};

export type ExtensionsDefs = WorkspaceSettingsNewProps;

export class WorkspaceConfig implements HostConfig {
  _path?: string;
  _extensions: ExtensionsDefs;
  _legacyProps?: WorkspaceLegacyProps;

  constructor(private data?: WorkspaceConfigFileProps, private legacyConfig?: LegacyWorkspaceConfig) {
    if (data) {
      const withoutInternalConfig = omit(INTERNAL_CONFIG_PROPS, data);
      this._extensions = withoutInternalConfig;
    } else {
      // We know we have either data or legacy config
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._extensions = transformLegacyPropsToExtensions(legacyConfig!);
      if (legacyConfig) {
        this._legacyProps = {
          dependenciesDirectory: legacyConfig.dependenciesDirectory,
          resolveModules: legacyConfig.resolveModules,
          saveDependenciesAsComponents: legacyConfig.saveDependenciesAsComponents,
          distEntry: legacyConfig.distEntry,
          distTarget: legacyConfig.distTarget
        };
      }
    }
  }

  get path(): PathOsBased {
    return this._path || this.legacyConfig?.path || '';
  }

  set path(configPath: PathOsBased) {
    this._path = configPath;
  }

  get extensions(): ExtensionConfigList {
    const res = ExtensionConfigList.fromObject(this._extensions);
    return res;
  }

  extension(extensionId: string, ignoreVersion: boolean): ExtensionConfigEntry {
    const existing = this.extensions.findExtension(extensionId, ignoreVersion);
    return existing?.config;
  }

  /**
   * Create an instance of the WorkspaceConfig by an instance of the legacy config
   *
   * @static
   * @param {*} legacyConfig
   * @returns
   * @memberof WorkspaceConfig
   */
  static fromLegacyConfig(legacyConfig) {
    return new WorkspaceConfig(undefined, legacyConfig);
  }

  /**
   * Create an instance of the WorkspaceConfig by data
   *
   * @static
   * @param {WorkspaceConfigFileProps} data
   * @returns
   * @memberof WorkspaceConfig
   */
  static fromObject(data: WorkspaceConfigFileProps) {
    return new WorkspaceConfig(data, undefined);
  }

  /**
   * Create an instance of the WorkspaceConfig by the workspace config template and override values
   *
   * @static
   * @param {WorkspaceConfigFileProps} data values to override in the default template
   * @returns
   * @memberof WorkspaceConfig
   */
  static async create(
    props: WorkspaceConfigFileProps,
    dirPath?: PathOsBasedAbsolute,
    legacyInitProps?: LegacyInitProps
  ) {
    if (isFeatureEnabled('legacy-workspace-config') && dirPath) {
      // Only support here what needed for e2e tests
      const legacyProps = {
        packageManager: props['@teambit/dependency-resolver'].packageManager,
        componentsDefaultDirectory: props['@teambit/workspace'].defaultDirectory
      };
      const standAlone = legacyInitProps?.standAlone ?? false;
      const legacyConfig = await LegacyWorkspaceConfig._ensure(dirPath, standAlone, legacyProps);
      const instance = WorkspaceConfig.fromLegacyConfig(legacyConfig);
      return instance;
    }
    const getTemplateFile = async () => {
      try {
        return await fs.readFile(path.join(__dirname, 'workspace-template.jsonc'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // when the extension is compiled by tsc, it doesn't copy .jsonc files into the dists, grab it from src
        return fs.readFile(path.join(__dirname, '..', 'workspace-template.jsonc'));
      }
    };
    const templateFile = await getTemplateFile();
    const templateStr = templateFile.toString();
    const template = parse(templateStr);
    const merged = assign(template, props);
    const instance = new WorkspaceConfig(merged, undefined);
    if (dirPath) {
      instance.path = WorkspaceConfig.composeWorkspaceJsoncPath(dirPath);
    }
    return instance;
  }

  /**
   * Ensure the given directory has a workspace config
   * Load if existing and create new if not
   *
   * @static
   * @param {PathOsBasedAbsolute} dirPath
   * @param {WorkspaceConfigFileProps} [workspaceConfigProps={} as any]
   * @returns {Promise<WorkspaceConfig>}
   * @memberof WorkspaceConfig
   */
  static async ensure(
    dirPath: PathOsBasedAbsolute,
    workspaceConfigProps: WorkspaceConfigFileProps = {} as any,
    legacyInitProps?: LegacyInitProps
  ): Promise<WorkspaceConfig> {
    try {
      let workspaceConfig = await this.loadIfExist(dirPath);
      if (workspaceConfig) {
        return workspaceConfig;
      }
      workspaceConfig = await this.create(workspaceConfigProps, dirPath, legacyInitProps);
      return workspaceConfig;
    } catch (err) {
      if (err instanceof InvalidBitJson) {
        const workspaceConfig = this.create(workspaceConfigProps, dirPath);
        return workspaceConfig;
      }
      throw err;
    }
  }

  /**
   * A function that register to the legacy ensure function in order to transform old props structure
   * to the new one
   * @param dirPath
   * @param standAlone
   * @param legacyWorkspaceConfigProps
   */
  static async onLegacyEnsure(
    dirPath: PathOsBasedAbsolute,
    standAlone: boolean,
    legacyWorkspaceConfigProps: LegacyWorkspaceConfigProps = {} as any
  ): Promise<WorkspaceConfig> {
    const newProps: WorkspaceConfigFileProps = transformLegacyPropsToExtensions(legacyWorkspaceConfigProps);
    // TODO: gilad move to constants file
    newProps.$schemaVersion = '1.0.0';
    return WorkspaceConfig.ensure(dirPath, newProps, { standAlone });
  }

  static async reset(dirPath: PathOsBasedAbsolute, resetHard: boolean): Promise<void> {
    const workspaceJsoncPath = WorkspaceConfig.composeWorkspaceJsoncPath(dirPath);
    if (resetHard) {
      // Call the legacy reset hard to make sure there is no old bit.json kept
      LegacyWorkspaceConfig.reset(dirPath, true);
      if (workspaceJsoncPath) {
        logger.info(`deleting the consumer bit.jsonc file at ${workspaceJsoncPath}`);
        await fs.remove(workspaceJsoncPath);
      }
    }
  }

  /**
   * Get the path of the bit.jsonc file by a containing folder
   *
   * @static
   * @param {PathOsBased} dirPath containing dir of the bit.jsonc file
   * @returns {PathOsBased}
   * @memberof WorkspaceConfig
   */
  static composeWorkspaceJsoncPath(dirPath: PathOsBased): PathOsBased {
    return path.join(dirPath, WORKSPACE_JSONC);
  }

  static async pathHasWorkspaceJsonc(dirPath: PathOsBased): Promise<boolean> {
    return fs.pathExists(WorkspaceConfig.composeWorkspaceJsoncPath(dirPath));
  }

  /**
   * Load the workspace configuration if it's exist
   *
   * @static
   * @param {PathOsBased} dirPath
   * @returns {(Promise<WorkspaceConfig | undefined>)}
   * @memberof WorkspaceConfig
   */
  static async loadIfExist(dirPath: PathOsBased): Promise<WorkspaceConfig | undefined> {
    const jsoncExist = await WorkspaceConfig.pathHasWorkspaceJsonc(dirPath);
    if (jsoncExist) {
      const jsoncPath = WorkspaceConfig.composeWorkspaceJsoncPath(dirPath);
      const instance = await WorkspaceConfig._loadFromWorkspaceJsonc(jsoncPath);
      instance.path = jsoncPath;
      return instance;
    }
    const legacyConfig = await LegacyWorkspaceConfig._loadIfExist(dirPath);
    if (legacyConfig) {
      return WorkspaceConfig.fromLegacyConfig(legacyConfig);
    }
    return undefined;
  }

  static async _loadFromWorkspaceJsonc(workspaceJsoncPath: PathOsBased): Promise<WorkspaceConfig> {
    const contentBuffer = await fs.readFile(workspaceJsoncPath);
    try {
      const parsed = parse(contentBuffer.toString());
      return WorkspaceConfig.fromObject(parsed);
    } catch (e) {
      throw new InvalidConfigFile(workspaceJsoncPath);
    }
  }

  async write({ workspaceDir }: { workspaceDir: PathOsBasedAbsolute }): Promise<void> {
    if (this.data) {
      const files = await this.toVinyl(workspaceDir);
      const dataToPersist = new DataToPersist();
      if (files) {
        dataToPersist.addManyFiles(files);
        return dataToPersist.persistAllToFS();
      }
    }
    await this.legacyConfig?.write({ workspaceDir });
    return undefined;
  }

  async toVinyl(workspaceDir: PathOsBasedAbsolute): Promise<AbstractVinyl[] | undefined> {
    if (this.data) {
      const jsonStr = stringify(this.data, undefined, 2);
      const base = workspaceDir;
      const fullPath = workspaceDir ? WorkspaceConfig.composeWorkspaceJsoncPath(workspaceDir) : this.path;
      const jsonFile = new AbstractVinyl({ base, path: fullPath, contents: Buffer.from(jsonStr) });
      return [jsonFile];
    }
    return this.legacyConfig?.toVinyl({ workspaceDir });
  }

  _legacyPlainObject(): { [prop: string]: any } | undefined {
    if (this.legacyConfig) {
      return this.legacyConfig.toPlainObject();
    }
    return undefined;
  }

  toLegacy(): ILegacyWorkspaceConfig {
    const _setCompiler = compiler => {
      if (this.legacyConfig) {
        this.legacyConfig.setCompiler(compiler);
      }
    };

    const _setTester = tester => {
      if (this.legacyConfig) {
        this.legacyConfig.setTester(tester);
      }
    };

    const _getEnvsByType = (type: EnvType): Compilers | Testers | undefined => {
      if (type === COMPILER_ENV_TYPE) {
        return this.legacyConfig?.compiler;
      }
      return this.legacyConfig?.tester;
    };

    return {
      lang: this.legacyConfig?.lang || DEFAULT_LANGUAGE,
      defaultScope: this.data?.['@teambit/workspace'].defaultScope,
      _useWorkspaces: this.data?.['@teambit/dependency-resolver'].useWorkspaces,
      dependencyResolver: this.data?.['@teambit/dependency-resolver'],
      packageManager: this.data?.['@teambit/dependency-resolver'].packageManager,
      _bindingPrefix: this.data?.['@teambit/workspace'].defaultOwner,
      _distEntry: this._legacyProps?.distEntry,
      _distTarget: this._legacyProps?.distTarget,
      _saveDependenciesAsComponents: this._legacyProps?.saveDependenciesAsComponents,
      _dependenciesDirectory: this._legacyProps?.dependenciesDirectory,
      componentsDefaultDirectory: this.data?.['@teambit/workspace'].defaultDirectory,
      _resolveModules: this._legacyProps?.resolveModules,
      _manageWorkspaces: this.data?.['@teambit/dependency-resolver'].manageWorkspaces,
      defaultOwner: this.data?.['@teambit/workspace'].defaultOwner,
      // @ts-ignore
      path: this._path,
      _getEnvsByType,
      write: this.write.bind(this),
      toVinyl: this.toVinyl.bind(this),
      // componentsConfig: ConsumerOverrides | undefined,
      // getComponentConfig: (componentId: BitId) => ConsumerOverridesOfComponent,
      _legacyPlainObject: this.legacyConfig ? this.legacyConfig?.toPlainObject.bind(this) : () => undefined,
      _compiler: this.legacyConfig?.compiler,
      _setCompiler,
      _tester: this.legacyConfig?.tester,
      _setTester
    };
  }
}

function transformLegacyPropsToExtensions(legacyConfig: LegacyWorkspaceConfig | LegacyWorkspaceConfigProps) {
  const data = {
    '@teambit/workspace': {
      defaultScope: legacyConfig.defaultScope,
      defaultDirectory: legacyConfig.componentsDefaultDirectory,
      defaultOwner: legacyConfig.bindingPrefix
    },
    '@teambit/dependency-resolver': {
      packageManager: legacyConfig.packageManager,
      strictPeerDependnecies: false,
      extraArgs: legacyConfig.packageManagerArgs,
      packageManagerProcessOptions: legacyConfig.packageManagerProcessOptions,
      manageWorkspaces: legacyConfig.manageWorkspaces,
      useWorkspaces: legacyConfig.useWorkspaces
    }
    // TODO: add variants here once we have a way to pass the deps overrides and general key vals for package.json to
    // TODO: new extensions (via dependency-resolver extension and pkg extensions)
  };
  return data;
}