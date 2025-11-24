// Copyright (c) ipylab contributors
// Distributed under the terms of the Modified BSD License.

import { ObservableMap } from '@jupyterlab/observables';
import type { LabIcon } from '@jupyterlab/ui-components';
import type { ISerializers } from '@jupyter-widgets/base';
import { unpack_models, WidgetModel } from '@jupyter-widgets/base';

import { ArrayExt } from '@lumino/algorithm';

import type { CommandRegistry } from '@lumino/commands';

import type { JSONObject, ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { PromiseDelegate } from '@lumino/coreutils';
import { UUID } from '@lumino/coreutils';

import type { IDisposable } from '@lumino/disposable';

import { MODULE_NAME, MODULE_VERSION } from '../version';

import type AjvType from 'ajv';

/**
 * The model for a command registry.
 */
export class CommandRegistryModel extends WidgetModel {
  /**
   * The default attributes.
   */
  defaults(): any {
    return {
      ...super.defaults(),
      _model_name: CommandRegistryModel.model_name,
      _model_module: CommandRegistryModel.model_module,
      _model_module_version: CommandRegistryModel.model_module_version,
      _command_list: [],
      _commands: []
    };
  }

  /**
   * Initialize a CommandRegistryModel instance.
   *
   * @param attributes The base attributes.
   * @param options The initialization options.
   */
  initialize(attributes: any, options: any): void {
    this._commands = CommandRegistryModel.commands;
    super.initialize(attributes, options);
    this.on('msg:custom', this._onMessage.bind(this));
    this.on('comm_live_update', () => {
      if (this.comm_live) {
        return;
      }
      Private.customCommands.values().forEach(command => command.dispose());
      this._sendCommandList();
    });

    // restore existing commands
    const commands = this.get('_commands');
    Promise.all(commands.map((command: any) => this._addCommand(command)))
      .then(() => this._sendCommandList())
      .catch(console.warn);
  }

  /**
   * Handle a custom message from the backend.
   *
   * @param msg The message to handle.
   */
  private async _onMessage(msg: Private.TAnyRequest): Promise<void> {
    let result: Private.IResult | void = void 0;

    switch (msg.func) {
      case 'execute':
        result = await this._execute(msg.payload);
        break;
      case 'finishExecute':
        await this._finishExecute(msg.payload);
        break;
      case 'describe':
        result = await this._describe(msg.payload);
        break;
      case 'addCommand':
        await this._addCommand(msg.payload);
        break;
      case 'removeCommand':
        this._removeCommand(msg.payload);
        break;
      default:
        console.error(`unexpected function: ${(msg as any).func}`);
        break;
    }

    if (result) {
      this.send(result, {});
    }
  }

  /**
   * Send the list of commands to the backend.
   */
  private _sendCommandList(): void {
    this._commands.notifyCommandChanged();
    this.set('_command_list', this._commands.listCommands());
    this.save_changes();
  }

  /**
   * Execute a command.
   */
  private async _execute(
    options: Private.IExecuteOptions
  ): Promise<Private.IResult | void> {
    const { id, args, validate, result_id } = options;

    const response: Private.IResult = {
      event: 'executed',
      result_id,
      result: null,
      errors: []
    };

    if (validate) {
      try {
        // expected errors will have a nice structure
        const validationErrors = await this._validateArgs(options);
        response.errors.push(...validationErrors);
      } catch (err) {
        // ... best effort for an unexpected error
        response.errors.push(Private.maybeJson(err));
      }
    }

    if (!response.errors.length) {
      try {
        response.result = await this._commands.execute(id, args);
      } catch (err) {
        // ... a real execution error _is_ an error (though unlikely)
        response.errors.push(Private.maybeJson(err));
      }
    }

    if (!result_id) {
      return;
    }

    try {
      // results _should_ be well-formed JSON...
      response.result = Private.maybeJson(response.result);
    } catch (err) {
      // ... but in practice often aren't, and may have hot widget/DOM handles
      //     and this isn't really an error
      response.result = `${response.result}`;
    }

    return response;
  }

  /**
   * Finish results from a custom kernel-side command.
   */
  private async _finishExecute(options: Private.IExecuteResultsOptions) {
    const { result_id, result, errors } = options;
    const delegate = this._executeResults.get(result_id);
    this._executeResults.delete(result_id);
    if (errors.length) {
      delegate.reject(errors);
    } else {
      delegate.resolve(result);
    }
  }

  /**
   * Get command information.
   */
  private async _describe(
    options: Private.IDescribeOptions
  ): Promise<Private.IResult> {
    const { id, result_id, args } = options;
    const message: Private.IResult = {
      result_id,
      event: 'described',
      result: { id },
      errors: []
    };

    const promises: Promise<void>[] = [];

    for (const key of Private.DESCRIBE_KEYS) {
      promises.push(
        this._reduceInfo(message.result, message.errors, key, id, args)
      );
    }

    await Promise.all(promises);

    return message;
  }

  private async _reduceInfo(
    result: Record<string, any>,
    errors: any[],
    key: Private.TDecribeKey,
    id: string,
    args: ReadonlyPartialJSONObject
  ): Promise<void> {
    const infoMethods: Private.IDescribeMethods = {
      label: this._commands.label,
      caption: this._commands.caption,
      described_by: this._commands.describedBy,
      icon_class: this._commands.iconClass
    };
    try {
      const r = await infoMethods[key].bind(this._commands)(id, args);
      result[key] = Private.maybeJson(r);
    } catch (err) {
      errors.push({ [key]: `${err}` });
    }
  }

  /**
   * Validate command args (if constrained)
   */
  private async _validateArgs(
    options: Private.IExecuteOptions
  ): Promise<any[]> {
    const { id, args } = options;
    const describedBy = await this._commands.describedBy(id, args);
    const errors: any[] = [];
    if (describedBy.args) {
      try {
        const ajv = await Private.ajv();
        if (!ajv.validate(describedBy.args, options.args)) {
          errors.push(Private.maybeJson(ajv.errors));
        }
      } catch (err) {
        errors.push(Private.maybeJson(err));
      }
    }
    return errors;
  }

  /**
   * Add a new command to the command registry.
   *
   * @param options The command options.
   */
  private async _addCommand(
    options: Private.IAddCommandOptions
  ): Promise<void> {
    const { id, caption, label, iconClass, icon, describedBy } = options;
    if (this._commands.hasCommand(id)) {
      Private.customCommands.get(id).dispose();
    }

    let labIcon: LabIcon | null = null;
    if (icon) {
      labIcon = (await unpack_models(icon, this.widget_manager))?.labIcon;
    }

    const commandEnabled = (command: IDisposable): boolean => {
      return !command.isDisposed && !!this.comm && this.comm_live;
    };

    const command = this._commands.addCommand(id, {
      caption,
      label,
      iconClass,
      icon: labIcon,
      execute: async (args): Promise<any> => {
        if (!this.comm_live) {
          command.dispose();
          throw Error(`${id} was disposed`);
        }

        const result_id = UUID.uuid4();
        const delegate = new PromiseDelegate<any>();

        this._executeResults.set(result_id, delegate);

        this.send(
          {
            event: 'execute',
            id,
            result_id,
            args: Private.maybeJson(args)
          },
          {}
        );
        return delegate.promise;
      },
      isEnabled: () => commandEnabled(command),
      isVisible: () => commandEnabled(command),
      describedBy
    });
    Private.customCommands.set(id, command);
    this._sendCommandList();

    // keep track of the commands
    const commands = this.get('_commands');
    this.set('_commands', commands.concat(options));
    this.save_changes();
  }

  /**
   * Remove a command from the command registry.
   *
   * @param options The options for removing the command.
   */
  private _removeCommand(options: Private.IRemoveCommandOptions): void {
    const { id } = options;
    if (Private.customCommands.has(id)) {
      Private.customCommands.get(id).dispose();
    }
    const commands = this.get('_commands').slice();
    ArrayExt.removeAllWhere(commands, (w: any) => w.id === id);
    this.set('_commands', commands);
    this.save_changes();
    this._sendCommandList();
  }

  static serializers: ISerializers = {
    ...WidgetModel.serializers
  };

  static model_name = 'CommandRegistryModel';
  static model_module = MODULE_NAME;
  static model_module_version = MODULE_VERSION;
  static view_name: string = null;
  static view_module: string = null;
  static view_module_version = MODULE_VERSION;

  private _commands: CommandRegistry;
  private _executeResults: Map<string, PromiseDelegate<any>> = new Map();

  static commands: CommandRegistry;
}

/**
 * A namespace for private data
 */
namespace Private {
  export const customCommands = new ObservableMap<IDisposable>();
  let _ajv: AjvType | null = null;

  export const DESCRIBE_KEYS = [
    'label',
    'caption',
    'icon_class',
    'described_by'
  ];
  export type TDecribeKey = (typeof DESCRIBE_KEYS)[number];

  export interface IDescribeMethods {
    [key: TDecribeKey]: (id: string, args: ReadonlyPartialJSONObject) => any;
  }

  export async function ajv(): Promise<AjvType> {
    if (!_ajv) {
      const Ajv = (await import('ajv')).default;
      _ajv = new Ajv({ validateFormats: true });
    }
    return _ajv;
  }

  export function maybeJson(data: any): any {
    try {
      return JSON.parse(JSON.stringify(data, null, 2));
    } catch (err) {
      return `${data}`;
    }
  }

  // messages
  export type TAnyRequest =
    | IExecute
    | IExecuteResults
    | IDescribe
    | IAddCommand
    | IRemoveCommand;

  export interface IRequest {
    func:
      | 'addCommand'
      | 'describe'
      | 'finishExecute'
      | 'removeCommand'
      | 'execute';
    payload: any;
  }

  export interface IAddCommand extends IRequest {
    func: 'addCommand';
    payload: IAddCommandOptions;
  }

  export interface IRemoveCommand extends IRequest {
    func: 'removeCommand';
    payload: IRemoveCommandOptions;
  }

  export interface IDescribe extends IRequest {
    func: 'describe';
    payload: IDescribeOptions;
  }

  export interface IExecute extends IRequest {
    func: 'execute';
    payload: IExecuteOptions;
  }

  export interface IExecuteResults extends IRequest {
    func: 'finishExecute';
    payload: IExecuteResultsOptions;
  }

  // options
  export interface IWithCommandId {
    /** command id */
    id: string;
  }

  export interface ICommonOptions extends IWithCommandId {
    /** optional command args */
    args?: ReadonlyPartialJSONObject;
    /** an optional identifier for an expected result */
    result_id?: string | null;
  }

  export interface IExecuteOptions extends ICommonOptions {
    /** whether to pre-validate args before execution (if defined) */
    validate?: boolean;
  }

  export interface IExecuteResultsOptions extends ICommonOptions {
    /** optional identifier for an expected result */
    result_id: string;
    /** result of the kernel-side execution */
    result: ReadonlyPartialJSONObject;
    /** errors encountered during kernel execution */
    errors: any[];
  }

  export interface IDescribeOptions extends ICommonOptions {
    result_id: string;
  }

  export interface IAddCommandOptions
    extends IWithCommandId,
      CommandRegistry.ICommandOptions {}

  export interface IRemoveCommandOptions extends IWithCommandId {}

  export interface IResult extends JSONObject {
    event: 'executed' | 'described';
    /** the execution request */
    result_id: string;
    /** a result, if successful */
    result: any;
    /** an error string, if failed */
    errors: any[];
  }
}
