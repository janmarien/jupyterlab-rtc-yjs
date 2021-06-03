/**
 * @author Mariën Jan
 */

import { INotebookModel, Notebook, NotebookActions, NotebookPanel } from '@jupyterlab/notebook'
import { v4 as uuid } from 'uuid'
import { CodeMirrorBinding, CodemirrorBinding } from 'y-codemirror'
import { CodeMirrorEditor } from '@jupyterlab/codemirror'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { Cell, ICellModel, CodeCell } from '@jupyterlab/cells'
import { IObservableUndoableList, IObservableList } from '@jupyterlab/observables'
import { Dialog } from '@jupyterlab/apputils'
import { Panel, PanelLayout } from '@lumino/widgets'
import { Slot } from '@lumino/signaling'
import { MessageLoop, MessageHook } from '@lumino/messaging'
import { IOutput } from '@jupyterlab/nbformat';
import { Colors } from './colors'
import { IOutputModel } from '@jupyterlab/rendermime'
import { DocumentRegistry } from '@jupyterlab/docregistry'

/**
 * RTCNotebook class. Handles all local and remote changes to the shared notebook.
 * 
 */
export class RTCNotebook {
    private _panel: NotebookPanel
    private _notebook: Notebook
    private _doc: Y.Doc
    private _cells: Y.Map<Y.Map<any>>
    private _notebookID: string
    private _hubUser: string
    private _hubHost: Y.Text
    private _hosting: boolean = false
    private _ws: WebsocketProvider
    private _bindings: Map<string, CodemirrorBinding>
    private _initialised: boolean = false
    private _localListenerSlot: Slot<IObservableUndoableList<ICellModel>, IObservableList.IChangedArgs<ICellModel>>
    private _localExecutionListenerSlot: Slot<any, { notebook: Notebook, cell: Cell<ICellModel> }>
    private _remoteListenerFunction: (a: Y.YEvent[], b: Y.Transaction) => void
    private _hostListenerFunction: (e: Y.YTextEvent, t: Y.Transaction) => void
    private _closeHandler: MessageHook
    private _saveHandler: Slot<DocumentRegistry.IContext<INotebookModel>, DocumentRegistry.SaveState>


    /**
     * 
     * @param {NotebookPanel} panel Notebookpanel hosting the notebook
     * @param {string} notebookID RTC-ID of the notebook
     * @param {string} hubUser JupyterHub username
     * @param {string} hubHost JupyterHub host
     * @param {Y.Doc} doc Shared Y.Doc
     * @param {boolean} fromFile Whether or not the notebook has been loaded from disk
     */
    constructor(panel: NotebookPanel, notebookID: string, hubUser: string, hubHost: string, doc: Y.Doc, fromFile: boolean) {
        this._notebookID = notebookID
        this._doc = doc
        this._cells = doc.getMap('cells')
        this._bindings = new Map<string, CodemirrorBinding>()
        this._panel = panel
        this._notebook = panel.content as Notebook
        this._hubHost = doc.getText('host')
        this._hubUser = hubUser

        if (hubUser === this._notebook.model.metadata.get('owner') as string) {
            this._hosting = true
        }

        if (this._hosting || fromFile) {
            this._initialised = true
        }

        if (fromFile) {
            this.initRemoteListener()
        }

        this._ws = new WebsocketProvider(`ws://${hubHost}:1234`, this._notebookID, doc)

        this._ws.awareness.setLocalStateField('user', { name: hubUser, color: Colors.random() })

        this._ws.once('sync', (_synced: boolean) => {
            if (!this._initialised) {
                const arr: { map: Y.Map<any>, id: string }[] = new Array()
                this._cells.forEach((map, id) => {
                    arr.push({ map: map, id: id })
                })
                arr.sort((a, b) => a.map.get('position') - b.map.get('position'))
                arr.forEach(m => {
                    let cellModel
                    switch (m.map.get('type')) {
                        case 'code':
                            cellModel = this._notebook.model.contentFactory.createCodeCell({})
                            break;
                        case 'markdown':
                            cellModel = this._notebook.model.contentFactory.createMarkdownCell({})
                            break
                        case 'raw':
                            cellModel = this._notebook.model.contentFactory.createRawCell({})
                            break
                        default:
                            cellModel = this._notebook.model.contentFactory.createCell(this._notebook.notebookConfig.defaultCell, {})
                            break;
                    }
                    cellModel.metadata.set('rtc-id', m.id)
                    cellModel.metadata.set('xCount', m.map.get('xCount'))
                    this._notebook.model.cells.insert(m.map.get('position'), cellModel)
                    this.bindCell(this._notebook.widgets[m.map.get('position')])
                })
                // Remove last cell
                this._notebook.model.cells.remove(this._notebook.model.cells.length - 1)
            }
            this.setOutputs()
            this.initLocalListener()
            this.initLocalExecutionListener()
            this.hostChangeListener()
            this.bindAllCells()
            if (!fromFile) {
                this.initRemoteListener()
            }
            if (this._ws.awareness.getStates().size === 1 && !this._hosting) {
                this._hosting = true
                this._hubHost.delete(0, this._hubHost.length)
                this._hubHost.insert(0, this._hubUser)
                this.becomeHost()
            }
        })


        this.initCloseHandler()
        this.initSaveHandler()
    }

    /**
     * 
     * @param {NotebookPanel} panel Notebookpanel hosting the notebook
     * @param {string} hubHost JupyterHub host
     * @param {string} hubUser JupyterHub username 
     * @returns 
     */
    static createNew(panel: NotebookPanel, hubHost: string, hubUser: string): RTCNotebook {

        const newID = uuid().toString()
        panel.content.model.metadata.set('rtc-id', newID)
        if (hubUser) {
            panel.content.model.metadata.set('owner', hubUser)
        }
        panel.context.save()

        const doc = new Y.Doc()
        doc.getText('host').insert(0, hubUser)
        const cells = doc.getMap('cells') as Y.Map<Y.Map<any>>
        panel.content.widgets.forEach((cell, i) => {
            const cellID = uuid().toString()
            cell.model.metadata.set('rtc-id', cellID)
            cell.model.metadata.set('xCount', 0)
            const metadata = new Y.Map as Y.Map<any>
            metadata.set('type', cell.model.type)
            metadata.set('xCount', 0)
            metadata.set('output', new Array())
            metadata.set('position', i)
            cells.set(cellID, metadata)
            const text = doc.getText(cellID)
            text.insert(0, cell.model.value.text)

            if (cell.model.type === 'code') {
                const outputs = new Array() as Array<IOutput>
                const codeCell = cell as CodeCell
                for (let index = 0; index < codeCell.outputArea.model.length; index++) {
        
                    const o = codeCell.outputArea.model.get(index) as IOutputModel;
                    outputs.push(o.toJSON())
                }
                metadata.set('output', outputs)
            }
        })
        return new RTCNotebook(panel, newID, hubUser, hubHost, doc, false)
    }

    /**
     * 
     * @param {NotebookPanel} panel Notebookpanel hosting the notebook
     * @param {string} notebookID ID of the shared notebook
     * @param {string} hubHost JupyterHub host
     * @param {string} hubUser JupyterHub username
     * @returns 
     */
    static connect(panel: NotebookPanel, notebookID: string, hubHost: string, hubUser: string): RTCNotebook {
        panel.sessionContext.ready.then(() => {
            // Shutdown context cause we will use 'shared' kernel
            panel.sessionContext.shutdown().then(() => {
                // Set kernel name to 'Shared'
                const kernelNameButton = panel.toolbar.node.getElementsByClassName('jp-KernelName')[0]
                const kernelText = kernelNameButton.getElementsByClassName('jp-ToolbarButtonComponent-label')[0] as HTMLElement
                kernelText.innerText = 'Shared Kernel'
            })
        })
        const doc = new Y.Doc()
        return new RTCNotebook(panel, notebookID, hubUser, hubHost, doc, false)
    }

    /**
     * 
     * @param {NotebookPanel} panel Notebookpanel hosting the notebook
     * @param {string} notebookID ID of the shared notebook
     * @param {string} hubHost JupyterHub host
     * @param {string} hubUser JupyterHub username
     * @returns 
     */
    static load(panel: NotebookPanel, notebookID: string, hubHost: string, hubUser: string): RTCNotebook {
        const notebook = panel.content as Notebook
        const str = notebook.model.metadata.get("rtc-doc") as string
        const arr = JSON.parse(str)
        const state = new Uint8Array(arr)
        const doc = new Y.Doc()
        Y.applyUpdateV2(doc, state)
        return new RTCNotebook(panel, notebookID, hubUser, hubHost, doc, true)
    }

    /**
     * Close the RTCNotebook.
     * Destroys all bindings.
     */
    close() {
        this._bindings.forEach(binding => {
            binding.destroy
        })
        this._bindings.clear()
        this.disconnectListeners()
        this._ws.destroy()

    }
    
    /**
     * Returns the RTC-ID for this notebook
     */
    public get notebookID() : string {
        return this._notebookID
    }
    
    /**
     * Initialises the handler that is called upon closing the notebook.
     * This handler assures that all bindings are correctly destroyed before closing and writes the contents of the Y.Doc to the notebook's metadata.
     */
    private initCloseHandler() {
        this._closeHandler = (_h, m) => {
            if (m.type === 'close-request' && !this._panel.context.model.dirty) {
                if (this._hosting) {
                    this.handleHostChange()
                }
                this.close()
                this._panel.dispose()
                return true
            }
            else if (m.type === 'close-request') {
                this.showSaveDialog().then(result => {
                    if (result.button.actions[0] === 'discard') {
                        if (this._hosting) {
                            this.handleHostChange()
                        }
                        this.close()
                        this._panel.dispose()
                        return false
                    }
                    if (result.button.accept) {
                        const state = Y.encodeStateAsUpdateV2(this._doc)
                        this._notebook.model.metadata.set('rtc-doc', JSON.stringify(Array.from(state)))
                        if (this._hosting) {
                            this.handleHostChange()
                        }
                        this._panel.context.save().then(() => {
                            this.close()
                            this._panel.dispose()
                        })
                        return false
                    }

                })
                return false
            }
            return true
        }
        MessageLoop.installMessageHook(this._panel, this._closeHandler)
    }

    /**
     * Initialises the savehandler which stores the serialised Y.Doc everytime a save is triggered.
     */
    private initSaveHandler() {

        this._saveHandler = (_sender, args) => {
            if (args === 'started') {
                const state = Y.encodeStateAsUpdateV2(this._doc)
                this._notebook.model.metadata.set('rtc-doc', JSON.stringify(Array.from(state)))
            }
        }
        this._panel.context.saveState.connect(this._saveHandler, this)
    }


    /**
     * Set the ouput for each cell if available.
     */
    private setOutputs() {
        this._notebook.widgets.forEach(cell => {
            const id = cell.model.metadata.get('rtc-id') as string
            this.handleOutputChange(id)
            if (this._cells.get(id).get('tag')) {
                cell.setPrompt(this._cells.get(id).get('tag'))
            }
        })
    }

    /**
     * Change the host to a randomly selected client (if other clients are connected)
     */
    private handleHostChange() {
        const states = Array.from(this._ws.awareness.states.keys())
        if (states.length > 1) {
            states.splice(states.indexOf(this._ws.awareness.clientID), 1)
            const randomHost = states[Math.floor(Math.random() * states.length)]
            const hostName = this._ws.awareness.states.get(randomHost).user.name
            this._hubHost.delete(0, this._hubHost.length)
            this._hubHost.insert(0, hostName)
        }
    }

    /**
     * Disconnect all listeners
     */
    private disconnectListeners() {
        this._notebook.model.cells.changed.disconnect(this._localListenerSlot, this)
        this._cells.unobserveDeep(this._remoteListenerFunction)
        this._doc.getText('host').unobserve(this._hostListenerFunction)
        if (this._localExecutionListenerSlot) {
            NotebookActions.executed.disconnect(this._localExecutionListenerSlot, this)
        }
        MessageLoop.removeMessageHook(this._panel, this._closeHandler)
        this._panel.context.saveState.disconnect(this._saveHandler, this)
    }

    /**
     * Initialises the remote listener.
     * The function will attach a listener to the cellmap (Y.Map) and handle all incoming changes. 
     */
    private initRemoteListener() {
        this._remoteListenerFunction = (e: Y.YEvent[], t) => {
            if (t.origin) {
                e.forEach(event => {
                    const mapEvent = event as Y.YMapEvent<Y.Map<any>>
                    if (mapEvent.path.length > 0) {
                        // Cell property changed
                        const change = mapEvent.changes.keys.keys().next().value
                        switch (change) {
                            case 'position':
                                this.handleMoveUpdate(mapEvent)
                                break
                            case 'type':
                                this.switchType(mapEvent)
                                break
                            case 'xCount':
                                if (this._hosting) {
                                    this.handleExecution(mapEvent)
                                }
                                break
                            case 'output':
                                if (!this._hosting) {
                                    this.handleOutputChange(mapEvent.path[0] as string)
                                }
                                break
                            case 'tag':
                                this.handleTag(mapEvent.path[0] as string)
                                break
                        }
                    }
                    else {
                        // Addition or deletion
                        mapEvent.changes.keys.forEach((change, id) => {
                            switch (change.action) {
                                case 'add':
                                    const type = this._cells.get(id).get('type') as string
                                    let cellModel
                                    switch (type) {
                                        case 'code':
                                            cellModel = this._notebook.model.contentFactory.createCodeCell({})
                                            break;
                                        case 'markdown':
                                            cellModel = this._notebook.model.contentFactory.createMarkdownCell({})
                                            break
                                        case 'raw':
                                            cellModel = this._notebook.model.contentFactory.createRawCell({})
                                            break
                                        default:
                                            cellModel = this._notebook.model.contentFactory.createCell(this._notebook.notebookConfig.defaultCell, {})
                                            break;
                                    }
                                    const position = this._cells.get(id).get('position') as number
                                    cellModel.metadata.set('rtc-id', id)
                                    cellModel.metadata.set('xCount', 0)
                                    this._notebook.model.cells.insert(position, cellModel)
                                    this.bindCell(this._notebook.widgets[position])
                                    break
                                case 'delete':
                                    this._bindings.get(id).destroy()
                                    this._bindings.delete(id)
                                    for (let i = 0; i < this._notebook.model.cells.length; i++) {
                                        const cell = this._notebook.model.cells.get(i)
                                        if (cell.metadata.get('rtc-id') === id) {
                                            this._notebook.model.cells.remove(i)
                                            break
                                        }
                                    }
                                    break
                            }
                        })
                    }
                });
            }
        }

        this._cells.observeDeep(this._remoteListenerFunction)
    }

    /**
     * Initialises the local listener.
     * This function will connect to the notebook's model and handle all cell changes.
     */
    private initLocalListener() {
        this._localListenerSlot = (_value: IObservableUndoableList<ICellModel>, changed: IObservableList.IChangedArgs<ICellModel>) => {
            switch (changed.type) {
                case 'add':
                    const cellModel = this._notebook.model.cells.get(changed.newIndex)
                    if (cellModel.metadata.get('rtc-id')) {
                        // cell was added by remote operation so don't insert it!
                        break
                    }
                    const cellID = uuid().toString();
                    cellModel.metadata.set('rtc-id', cellID)
                    cellModel.metadata.set('xCount', 0)
                    const metadata = new Y.Map
                    metadata.set('type', 'code')
                    metadata.set('xCount', 0)
                    metadata.set('output', new Y.Array)
                    this.bindCell(this._notebook.widgets[changed.newIndex])
                    metadata.set('position', changed.newIndex)
                    this._cells.set(cellID, metadata)
                    if (changed.newIndex < this._notebook.model.cells.length - 1) {
                        this.adjustIndexes(changed.newIndex + 1, this._notebook.model.cells.length - 1)
                    }
                    break
                case 'remove':
                    const deleteCellID = changed.oldValues[0].metadata.get('rtc-id') as string
                    if (!this._bindings.get(deleteCellID)) {
                        // Lengths are equal so cell is already deleted in remote array
                        break
                    }
                    this._bindings.get(deleteCellID).destroy()
                    this._bindings.delete(deleteCellID)
                    this._cells.delete(deleteCellID)
                    if (changed.oldIndex < this._notebook.model.cells.length) {
                        this.adjustIndexes(changed.oldIndex, this._notebook.model.cells.length - 1)
                    }
                    break
                case 'set':
                    const rid = changed.oldValues[0].metadata.get('rtc-id') as string
                    if (changed.newValues[0].type !== changed.oldValues[0].type) {
                        const cell = this._notebook.widgets[this.getCellIndex(rid)] as Cell
                        this.bindCell(cell)
                        const metadata = this._cells.get(rid) as Y.Map<any>

                        // Check if remote is up to date. If not, propagate change.
                        if (metadata.get('type') !== cell.model.type) {
                            metadata.set('type', cell.model.type)
                        }
                    }
                    break
                case 'move':
                    const id = changed.oldValues[0].metadata.get('rtc-id') as string
                    if (changed.oldIndex === changed.newIndex) {
                        // Nothing happened
                        return
                    }
                    if (this._cells.get(id).get('position') === changed.newIndex) {
                        // Remote map is already updated so we initiated this move
                        return
                    }
                    const m = this._cells.get(id)
                    m.set('position', changed.newIndex)
                    this.adjustIndexes(changed.oldIndex, changed.newIndex)
                    break
            }
        }
        this._notebook.model.cells.changed.connect(this._localListenerSlot, this)
    }

    /**
     * Initialises the executionlistener.
     * This function will listen to executed cells on non-hosting clients.
     */
    private initLocalExecutionListener() {
        if (!this._hosting) {
            this._localExecutionListenerSlot = (_sender, args) => {
                const originNotebook = args.notebook
                const cellID = args.cell.model.metadata.get('rtc-id') as string
                const metadata = this._cells.get(cellID) as Y.Map<any>
                if (originNotebook === this._notebook) {
                    switch (args.cell.model.type) {
                        case 'code':
                            args.cell.setPrompt('*')
                            if (!this.checkHostActive()) {
                                this._hosting = true
                                this._hubHost.delete(0, this._hubHost.length)
                                this._hubHost.insert(0, this._hubUser)
                                this.becomeHost()
                            }
                            let currentCount = metadata.get('xCount') as number
                            currentCount = currentCount === undefined ? 1 : currentCount + 1
                            metadata.set('xCount', currentCount)
                            break
                    }
                }
            }
            NotebookActions.executed.connect(this._localExecutionListenerSlot, this)
        }
    }

    /**
     * Handles a remote cell type change
     * @param {Y.YMapEvent<Y.Map<any>>} e Remote event
     * @returns {void} Nothing
     */
    private switchType(e: Y.YMapEvent<Y.Map<any>>): void {
        const id = e.path[0] as string
        const metadata = this._cells.get(id) as Y.Map<any>
        const type = metadata.get('type') as string
        const oldCell = this._notebook.widgets[this.getCellIndex(id)]
        if (oldCell.model.type === type) {
            return
        }
        switch (type) {
            case 'markdown':
                const markdownCell = this._notebook.model.contentFactory.createMarkdownCell({ cell: oldCell.model.toJSON() })
                this._notebook.model.cells.set(this.getCellIndex(id), markdownCell)
                break
            case 'code':
                const codeCell = this._notebook.model.contentFactory.createCodeCell({ cell: oldCell.model.toJSON() })
                this._notebook.model.cells.set(this.getCellIndex(id), codeCell)
                break
            case 'raw':
                const rawCell = this._notebook.model.contentFactory.createRawCell({ cell: oldCell.model.toJSON() })
                this._notebook.model.cells.set(this.getCellIndex(id), rawCell)
                break
        }
    }

    /**
     * Checks whether the hosting client is still connected.
     * @returns {boolean} Value indicating whether or not the hosting client is still connected to the WebSocket server
     */
    private checkHostActive(): boolean {
        let isActive = false
        this._ws.awareness.getStates().forEach(state => {
            if (state.user.name === this._hubHost.toString()) {
                isActive = true
                return
            }
        })
        return isActive
    }

    /**
     * Bind every cell of this notebook.
     */
    private bindAllCells() {
        this._notebook.widgets.forEach(cell => {
            this.bindCell(cell)
        })
    }

    /**
     * Binds a cell
     * @param {Cell} cell Cell to bind 
     */
    private bindCell(cell: Cell) {
        const cellID = cell.model.metadata.get('rtc-id') as string
        const text = this._doc.getText(cellID)
        const editor = cell.editor as CodeMirrorEditor
        
        if (cell.model.type === 'code') {
            cell.model.mimeType = 'text/x-ipython'
            const c = cell as CodeCell
            c.model.stateChanged.connect((_s, a) => {
                if (a.name === 'executionCount' && this._hosting) {
                    this._cells.get(cellID).set('tag', a.newValue)
                }

            }, this)
            c.model.outputs.changed.connect((_s, a) => {
                if (a.type === 'add' && this._hosting) {
                    this.updateCellOutput(c)
                }
            }, this)
        }
        const binding = new CodeMirrorBinding(text, editor.editor, this._ws.awareness)
        
        if (this._bindings.get(cellID) !== undefined) {
            this._bindings.get(cellID).destroy()
        }
        this._bindings.set(cellID, binding)
    }

    /**
     * 
     * @param {CodeCell} cell Cell of 'code' type for which to set the output
     */
    private updateCellOutput(cell: CodeCell) {
        cell.setPrompt('')
        const cellID = cell.model.metadata.get('rtc-id') as string
        const metadata = this._cells.get(cellID) as Y.Map<any>
        const outputs = new Array() as Array<IOutput>
        for (let index = 0; index < cell.outputArea.model.length; index++) {

            const o = cell.outputArea.model.get(index) as IOutputModel;
            outputs.push(o.toJSON())
        }
        metadata.set('output', outputs)
    }

    /**
     * Handles a change of the cell's output, this occurs after execution at the hosting client.
     * @param {string} cellID ID of cell for which the output changed
     */
    private handleOutputChange(cellID: string) {
        const metadata = this._cells.get(cellID) as Y.Map<any>
        const cell = this._notebook.widgets[this.getCellIndex(cellID)]
        if (cell.model.type === 'code') {
            const codeCell = cell as CodeCell
            const outputs = metadata.get('output') as IOutput[]
            codeCell.outputArea.model.clear(false)
            outputs.forEach(output => {
                codeCell.outputArea.model.add(output)
            });
        }
    }

    /**
     * Handle a tag change, this occurs after execution at the hosting client.
     * @param {string} cellID ID of the cell for which the tag changed
     */
    private handleTag(cellID: string) {
        const metadata = this._cells.get(cellID) as Y.Map<any>
        const cell = this._notebook.widgets[this.getCellIndex(cellID)]
        cell.setPrompt(metadata.get('tag'))
    }

    /**
     * Handles a remote execution request
     * @param {Y.YMapEvent<any>} e 
     * @returns {void} Nothing
     */
    private handleExecution(e: Y.YMapEvent<any>): void {
        const id = e.path[0] as string
        const cell = this._notebook.widgets[this.getCellIndex(id)] as CodeCell
        CodeCell.execute(cell, this._panel.sessionContext)
    }


    /**
     * Handle cell movement
     * @param {Y.YMapEvent<string>} e 
     * @returns {void} Nothing
     */
    private handleMoveUpdate(e: Y.YMapEvent<string>): void {
        e.changes.keys.forEach((change) => {
            const id = e.path[0] as string
            let oldPosition = change.oldValue
            const newPosition = this._cells.get(id).get('position') as number

            if (this._notebook.model.cells.get(newPosition).metadata.get('rtc-id') === id) {
                // This cell is already at it's correct position
                return
            }
            this._notebook.model.cells.move(oldPosition, newPosition)
        })
    }

    /**
     * Adjust all indexes in the shared map. This operation is called after a local addition, deletion or move operation.
     * @param {number} from Start (or end) position of the cell range that needs to be updated
     * @param {number} to End (or start) position of the cell range that needs to be updated
     */
    private adjustIndexes(from: number, to: number) {
        let start: number
        let end: number
        if (from <= to) {
            start = from
            end = to
        }
        if (from > to) {
            start = to
            end = from
        }

        for (let index = start; index <= end; index++) {
            const id = this._notebook.model.cells.get(index).metadata.get('rtc-id') as string
            const metadata = this._cells.get(id)
            metadata.set('position', index)
        }
    }

    /**
     * Returns the position of a given cell in the notebook.
     * @param {string} cellID ID of the cell for which to retrieve the position 
     * @returns {number} Position of the cell in the notebook
     */
    private getCellIndex(cellID: string): number {
        return this._cells.get(cellID).get('position') as number
    }

    /**
     * Initialises the listener that will respond to a switch of the hosting client.
     */
    private hostChangeListener() {
        this._hostListenerFunction = (e:Y.YTextEvent, t:Y.Transaction) => {
            e.changes.delta.forEach(delta => {
                if (delta.insert) {
                    this._panel.content.model.metadata.set('owner', delta.insert)
                    if (delta.insert === this._hubUser) {
                        this.becomeHost()
                    }
                }
            });
        }
        this._doc.getText('host').observe(this._hostListenerFunction)
    }

    /**
     * Initialise kernel after becoming the host
     */
    private becomeHost() {
        this._hosting = true
        this._panel.sessionContext.changeKernel({ name: 'python3' })
    }

    /**
     * Shows a custom dialog for handling notebook closure if the document is dirty.
     * @returns {Promise<Dialog.IResult>}
     */
    private showSaveDialog(): Promise<Dialog.IResult<unknown>> {
        const body = new Panel()
        const layout = new PanelLayout()
        layout.addWidget(body)
        const text = document.createElement('p')
        text.append('Save changes to this document before closing?')
        body.node.appendChild(text)
        body.node.appendChild(document.createElement('br'))
        const dialog = new Dialog({
            title: 'Save your work',
            body: body,
            buttons: [Dialog.cancelButton({
                accept: false
            }), Dialog.warnButton({
                label: 'Discard',
                accept: false,
                actions: ['discard']
            }), Dialog.okButton({
                label: 'Save',
                accept: true
            })],
        })
        return dialog.launch()
    }


}
