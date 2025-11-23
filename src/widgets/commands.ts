// Copyright (c) ipylab contributors
// Distributed under the terms of the Modified BSD License.

import { ObservableMap } from '@jupyterlab/observables';
import { LabIcon } from '@jupyterlab/ui-components';
import {
  ISerializers,
  unpack_models,
  WidgetModel
} from '@jupyter-widgets/base';

import { ArrayExt } from '@lumino/algorithm';

import type { CommandRegistry } from '@lumino/commands';

import type { JSONObject, ReadonlyPartialJSONObject } from '@lumino/coreutils';

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
  private async _onMessage(msg: Private.TAnyMessage): Promise<void> {
    switch (msg.func) {
      case 'execute':
        await this._execute(msg.payload);
        break;
      case 'describe':
        await this._describe(msg.payload);
        break;
      case 'addCommand': {
        await this._addCommand(msg.payload);
        // keep track of the commands
        const commands = this.get('_commands');
        this.set('_commands', commands.concat(msg.payload));
        this.save_changes();
        break;
      }
      case 'removeCommand':
        this._removeCommand(msg.payload);
        break;
      default:
        break;
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
   * Execute a command
   *
   * @param options The execute options.
   */
  private async _execute(options: Private.IExecuteOptions): Promise<void> {
    const { id, args, validate, result_id } = options;

    const message: Private.IResult = {
      event: 'executed',
      result_id,
      result: null,
      errors: []
    };

    try {
      validate && (await this._validateArgs(options));
      message.result = await this._commands.execute(id, args);
    } catch (err: any) {
      message.errors.push(`${err}`);
    }

    if (!result_id) {
      return;
    }

    try {
      // results _should_ be well-formed JSON...
      message.result = JSON.parse(JSON.stringify(message.result));
    } catch (err) {
      // ... but in practice often aren't, and may have hot widget/DOM handles
      message.result = `${message.result}`;
    }

    this.send(message, {});
  }
  /**
   * Get command information.
   *
   * @param options The execute options.
   */
  private async _describe(options: Private.IDescribeOptions): Promise<void> {
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

    this.send(message, {});
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
      result[key] = JSON.parse(JSON.stringify(r));
    } catch (err) {
      errors.push({ [key]: `${err}` });
    }
  }

  /**
   * Validate command args (if constrained)
   *
   * @param options The validation options.
   */
  private async _validateArgs(options: Private.IExecuteOptions): Promise<void> {
    const { id, args } = options;
    const describedBy = await this._commands.describedBy(id, args);
    if (!describedBy.args) {
      return;
    }
    const ajv = await Private.ajv();
    if (!ajv.validate(describedBy.args, options.args)) {
      throw new Error(JSON.stringify(ajv.errors, null, 2));
    }
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
      execute: args => {
        if (!this.comm_live) {
          command.dispose();
          return;
        }
        this.send({ event: 'execute', id, args: JSON.stringify(args) }, {});
      },
      isEnabled: () => commandEnabled(command),
      isVisible: () => commandEnabled(command),
      describedBy
    });
    Private.customCommands.set(id, command);
    this._sendCommandList();
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

  export type TAnyMessage = IExecute | IDescribe | IAddCommand | IRemoveCommand;

  export interface IMessage {
    func: string;
    payload: any;
  }

  export interface IAddCommand extends IMessage {
    func: 'addCommand';
    payload: IAddCommandOptions;
  }

  export interface IWithCommandId {
    /** command id */
    id: string;
  }

  export interface IDescribe extends IWithCommandId {
    func: 'describe';
    payload: IDescribeOptions;
  }

  export interface IExecute extends IMessage {
    func: 'execute';
    payload: IExecuteOptions;
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
  export interface IDescribeOptions extends ICommonOptions {
    result_id: string;
  }

  export interface IAddCommandOptions
    extends IWithCommandId,
      CommandRegistry.ICommandOptions {}

  export interface IRemoveCommand extends IMessage {
    func: 'removeCommand';
    payload: IRemoveCommandOptions;
  }

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
