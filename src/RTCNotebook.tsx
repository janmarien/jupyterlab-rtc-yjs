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
    panel: NotebookPanel
    notebook: Notebook
    doc: Y.Doc
    cells: Y.Map<Y.Map<any>>
    id: string
    username: string
    notebookHost: Y.Text
    hosting: boolean = false
    ws: WebsocketProvider
    bindings: Map<string, CodemirrorBinding>
    executionEnabled: boolean = true
    initialised: boolean = false
    moveQueue: Array<Y.YMapEvent<string>>
    localListenerSlot: Slot<IObservableUndoableList<ICellModel>, IObservableList.IChangedArgs<ICellModel>>
    localExecutionListenerSlot: Slot<any, { notebook: Notebook, cell: Cell<ICellModel> }>
    remoteListenerFunction: (a: Y.YEvent[], b: Y.Transaction) => void
    closeHandler: MessageHook
    saveHandler: Slot<DocumentRegistry.IContext<INotebookModel>, DocumentRegistry.SaveState>


    /**
     * 
     * @param {NotebookPanel} panel 
     * @param {string} id 
     * @param {string} user 
     * @param {string} hostname 
     * @param {Y.Doc} doc 
     * @param {boolean} fromFile 
     */
    constructor(panel: NotebookPanel, id: string, user: string, hostname: string, doc: Y.Doc, fromFile: boolean) {
        this.id = id
        this.doc = doc
        this.cells = doc.getMap('cells')
        this.bindings = new Map<string, CodemirrorBinding>()
        this.panel = panel
        this.notebook = panel.content as Notebook
        this.notebookHost = doc.getText('host')
        this.moveQueue = new Array()
        this.username = user
        if (user === this.notebook.model.metadata.get('owner') as string) {
            this.hosting = true
        }

        if (this.hosting || fromFile) {
            this.initialised = true
        }

        if (fromFile) {
            this.initRemoteListener()
        }

        this.ws = new WebsocketProvider(`ws://${hostname}:1234`, id, doc)
        this.ws.awareness.setLocalStateField('user', { name: user, color: Colors.random() })
        this.ws.once('sync', (_synced: boolean) => {
            if (!this.initialised) {
                const arr: { map: Y.Map<any>, id: string }[] = new Array()
                this.cells.forEach((map, id) => {
                    arr.push({ map: map, id: id })
                })
                arr.sort((a, b) => a.map.get('position') - b.map.get('position'))
                arr.forEach(m => {
                    let cellModel
                    switch (m.map.get('type')) {
                        case 'code':
                            cellModel = this.notebook.model.contentFactory.createCodeCell({})
                            break;
                        case 'markdown':
                            cellModel = this.notebook.model.contentFactory.createMarkdownCell({})
                            break
                        case 'raw':
                            cellModel = this.notebook.model.contentFactory.createRawCell({})
                            break
                        default:
                            cellModel = this.notebook.model.contentFactory.createCell(this.notebook.notebookConfig.defaultCell, {})
                            break;
                    }
                    cellModel.metadata.set('rtc-id', m.id)
                    cellModel.metadata.set('xCount', m.map.get('xCount'))
                    this.notebook.model.cells.insert(m.map.get('position'), cellModel)
                    this.bindCell(this.notebook.widgets[m.map.get('position')])
                })
                // Remove last cell
                this.notebook.model.cells.remove(this.notebook.model.cells.length - 1)
            }
            this.setOutputs()
            this.initLocalListener()
            this.initLocalExecutionListener()
            this.hostChangeListener()
            this.bindAllCells()
            if (!fromFile) {
                this.initRemoteListener()
            }
            if (this.ws.awareness.getStates().size === 1 && !this.hosting) {
                this.hosting = true
                this.notebookHost.delete(0, this.notebookHost.length)
                this.notebookHost.insert(0, this.username)
                this.becomeHost()
            }
        })


        this.initCloseHandler()
        this.initSaveHandler()
    }

    /**
     * 
     * @param panel 
     * @param host 
     * @param user 
     * @returns 
     */
    static createNew(panel: NotebookPanel, host: string, user: string): RTCNotebook {

        const newID = uuid().toString()
        panel.content.model.metadata.set('rtc-id', newID)
        if (user) {
            panel.content.model.metadata.set('owner', user)
        }
        panel.context.save()

        const doc = new Y.Doc()
        doc.getText('host').insert(0, user)
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
        return new RTCNotebook(panel, newID, user, host, doc, false)
    }

    /**
     * 
     * @param {NotebookPanel} panel 
     * @param {string} rtcID 
     * @param {string} host 
     * @param {string} user 
     * @returns 
     */
    static connect(panel: NotebookPanel, rtcID: string, host: string, user: string): RTCNotebook {
        panel.sessionContext.ready.then(() => {
            // Shutdown context cause we will use 'shared' kernel
            panel.sessionContext.shutdown().then(() => {
                const kernelNameButton = panel.toolbar.node.getElementsByClassName('jp-KernelName')[0]
                const kernelText = kernelNameButton.getElementsByClassName('jp-ToolbarButtonComponent-label')[0] as HTMLElement
                kernelText.innerText = 'Shared Kernel'
            })
        })
        const doc = new Y.Doc()
        return new RTCNotebook(panel, rtcID, user, host, doc, false)
    }

    /**
     * 
     * @param panel 
     * @param rtcID 
     * @param host 
     * @param user 
     * @returns 
     */
    static load(panel: NotebookPanel, rtcID: string, host: string, user: string): RTCNotebook {
        const notebook = panel.content as Notebook
        const str = notebook.model.metadata.get("rtc-doc") as string
        const arr = JSON.parse(str)
        const state = new Uint8Array(arr)
        const doc = new Y.Doc()
        Y.applyUpdateV2(doc, state)
        return new RTCNotebook(panel, rtcID, user, host, doc, true)
    }

    /**
     * Close the RTCNotebook.
     * Destroys all bindings.
     */
    close() {
        this.bindings.forEach(binding => {
            binding.destroy
        })
        this.bindings.clear()
        this.disconnectListeners()
        this.ws.destroy()

    }

    private initCloseHandler() {
        this.closeHandler = (_h, m) => {
            if (m.type === 'close-request' && !this.panel.context.model.dirty) {
                if (this.hosting) {
                    this.handleHostChange()
                }
                this.close()
                this.panel.dispose()
                return true
            }
            else if (m.type === 'close-request') {
                this.showSaveDialog().then(result => {
                    if (result.button.actions[0] === 'discard') {
                        if (this.hosting) {
                            this.handleHostChange()
                        }
                        this.close()
                        this.panel.dispose()
                        return false
                    }
                    if (result.button.accept) {
                        const state = Y.encodeStateAsUpdateV2(this.doc)
                        this.notebook.model.metadata.set('rtc-doc', JSON.stringify(Array.from(state)))
                        if (this.hosting) {
                            this.handleHostChange()
                        }
                        this.panel.context.save().then(() => {
                            this.close()
                            this.panel.dispose()
                        })
                        return false
                    }

                })
                return false
            }
            return true
        }
        MessageLoop.installMessageHook(this.panel, this.closeHandler)
    }

    /**
     * Initialises the savehandler which stores the serialised Y.Doc everytime a save is triggered.
     */
    private initSaveHandler() {

        this.saveHandler = (_sender, args) => {
            if (args === 'started') {
                const state = Y.encodeStateAsUpdateV2(this.doc)
                this.notebook.model.metadata.set('rtc-doc', JSON.stringify(Array.from(state)))
            }
        }
        this.panel.context.saveState.connect(this.saveHandler, this)
    }


    /**
     * Set the ouput for each cell if available.
     */
    private setOutputs() {
        this.notebook.widgets.forEach(cell => {
            const id = cell.model.metadata.get('rtc-id') as string
            this.handleOutputChange(id)
            if (this.cells.get(id).get('tag')) {
                cell.setPrompt(this.cells.get(id).get('tag'))
            }
        })
    }

    /**
     * Change the host to a randomly selected client (if other clients are connected)
     */
    private handleHostChange() {
        const states = Array.from(this.ws.awareness.states.keys())
        if (states.length > 1) {
            states.splice(states.indexOf(this.ws.awareness.clientID), 1)
            const randomHost = states[Math.floor(Math.random() * states.length)]
            const hostName = this.ws.awareness.states.get(randomHost).user.name
            this.notebookHost.delete(0, this.notebookHost.length)
            this.notebookHost.insert(0, hostName)
        }
    }

    /**
     * Disconnect all listeners
     */
    private disconnectListeners() {
        this.notebook.model.cells.changed.disconnect(this.localListenerSlot, this)
        this.cells.unobserveDeep(this.remoteListenerFunction)
        if (this.localExecutionListenerSlot) {
            NotebookActions.executed.disconnect(this.localExecutionListenerSlot, this)
        }
        MessageLoop.removeMessageHook(this.panel, this.closeHandler)
        this.panel.context.saveState.disconnect(this.saveHandler, this)
    }

    /**
     * Initialises the remote listener.
     * The function will attach a listener to the cellmap (Y.Map) and handle all incoming changes. 
     */
    private initRemoteListener() {
        this.remoteListenerFunction = (e: Y.YEvent[], t) => {
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
                                if (this.hosting) {
                                    this.handleExecution(mapEvent)
                                }
                                break
                            case 'output':
                                if (!this.hosting) {
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
                                    const type = this.cells.get(id).get('type') as string
                                    let cellModel
                                    switch (type) {
                                        case 'code':
                                            cellModel = this.notebook.model.contentFactory.createCodeCell({})
                                            break;
                                        case 'markdown':
                                            cellModel = this.notebook.model.contentFactory.createMarkdownCell({})
                                            break
                                        case 'raw':
                                            cellModel = this.notebook.model.contentFactory.createRawCell({})
                                            break
                                        default:
                                            cellModel = this.notebook.model.contentFactory.createCell(this.notebook.notebookConfig.defaultCell, {})
                                            break;
                                    }
                                    const position = this.cells.get(id).get('position') as number
                                    cellModel.metadata.set('rtc-id', id)
                                    cellModel.metadata.set('xCount', 0)
                                    this.notebook.model.cells.insert(position, cellModel)
                                    this.bindCell(this.notebook.widgets[position])
                                    break
                                case 'delete':
                                    this.bindings.get(id).destroy()
                                    this.bindings.delete(id)
                                    for (let i = 0; i < this.notebook.model.cells.length; i++) {
                                        const cell = this.notebook.model.cells.get(i)
                                        if (cell.metadata.get('rtc-id') === id) {
                                            this.notebook.model.cells.remove(i)
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

        this.cells.observeDeep(this.remoteListenerFunction)
    }

    /**
     * Initialises the local listener.
     * This function will connect to the notebook's model and handle all cell changes.
     */
    private initLocalListener() {
        this.localListenerSlot = (_value: IObservableUndoableList<ICellModel>, changed: IObservableList.IChangedArgs<ICellModel>) => {
            switch (changed.type) {
                case 'add':
                    const cellModel = this.notebook.model.cells.get(changed.newIndex)
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
                    this.bindCell(this.notebook.widgets[changed.newIndex])
                    metadata.set('position', changed.newIndex)
                    this.cells.set(cellID, metadata)
                    if (changed.newIndex < this.notebook.model.cells.length - 1) {
                        this.adjustIndexes(changed.newIndex + 1, this.notebook.model.cells.length - 1)
                    }
                    break
                case 'remove':
                    const deleteCellID = changed.oldValues[0].metadata.get('rtc-id') as string
                    if (!this.bindings.get(deleteCellID)) {
                        // Lengths are equal so cell is already deleted in remote array
                        break
                    }
                    this.bindings.get(deleteCellID).destroy()
                    this.bindings.delete(deleteCellID)
                    this.cells.delete(deleteCellID)
                    if (changed.oldIndex < this.notebook.model.cells.length) {
                        this.adjustIndexes(changed.oldIndex, this.notebook.model.cells.length - 1)
                    }
                    break
                case 'set':
                    const rid = changed.oldValues[0].metadata.get('rtc-id') as string
                    if (changed.newValues[0].type !== changed.oldValues[0].type) {
                        const cell = this.notebook.widgets[this.getCellIndex(rid)] as Cell
                        this.bindCell(cell)
                        const metadata = this.cells.get(rid) as Y.Map<any>

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
                    if (this.cells.get(id).get('position') === changed.newIndex) {
                        // Remote map is already updated so we initiated this move
                        return
                    }
                    const m = this.cells.get(id)
                    m.set('position', changed.newIndex)
                    this.adjustIndexes(changed.oldIndex, changed.newIndex)
                    break
            }
        }
        this.notebook.model.cells.changed.connect(this.localListenerSlot, this)
    }

    /**
     * Initialises the executionlistener.
     * This function will listen to executed cells on non-hosting clients.
     */
    private initLocalExecutionListener() {
        if (!this.hosting) {
            this.localExecutionListenerSlot = (_sender, args) => {
                const originNotebook = args.notebook
                const cellID = args.cell.model.metadata.get('rtc-id') as string
                const metadata = this.cells.get(cellID) as Y.Map<any>
                if (originNotebook === this.notebook) {
                    switch (args.cell.model.type) {
                        case 'code':
                            args.cell.setPrompt('*')
                            if (!this.checkHostActive()) {
                                this.hosting = true
                                this.notebookHost.delete(0, this.notebookHost.length)
                                this.notebookHost.insert(0, this.username)
                                this.becomeHost()
                            }
                            let currentCount = metadata.get('xCount') as number
                            currentCount = currentCount === undefined ? 1 : currentCount + 1
                            metadata.set('xCount', currentCount)
                            break
                    }
                }
            }
            NotebookActions.executed.connect(this.localExecutionListenerSlot, this)
        }
    }

    /**
     * Handles a remote cell type change
     * @param {Y.YMapEvent<Y.Map<any>>} e Remote event
     * @returns {void} 
     */
    private switchType(e: Y.YMapEvent<Y.Map<any>>): void {
        const id = e.path[0] as string
        const metadata = this.cells.get(id) as Y.Map<any>
        const type = metadata.get('type') as string
        const oldCell = this.notebook.widgets[this.getCellIndex(id)]
        if (oldCell.model.type === type) {
            return
        }
        switch (type) {
            case 'markdown':
                const markdownCell = this.notebook.model.contentFactory.createMarkdownCell({ cell: oldCell.model.toJSON() })
                this.notebook.model.cells.set(this.getCellIndex(id), markdownCell)
                break
            case 'code':
                const codeCell = this.notebook.model.contentFactory.createCodeCell({ cell: oldCell.model.toJSON() })
                this.notebook.model.cells.set(this.getCellIndex(id), codeCell)
                break
            case 'raw':
                const rawCell = this.notebook.model.contentFactory.createRawCell({ cell: oldCell.model.toJSON() })
                this.notebook.model.cells.set(this.getCellIndex(id), rawCell)
                break
        }
    }

    /**
     * Checks whether the hosting client is still connected.
     * @returns {boolean}
     */
    private checkHostActive() {
        let isActive = false
        this.ws.awareness.getStates().forEach(state => {
            if (state.user.name === this.notebookHost.toString()) {
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
        this.notebook.widgets.forEach(cell => {
            this.bindCell(cell)
        })
    }

    /**
     * Binds a cell
     * @param {Cell} cell Cell to bind 
     */
    private bindCell(cell: Cell) {
        const cellID = cell.model.metadata.get('rtc-id') as string
        const text = this.doc.getText(cellID)
        const editor = cell.editor as CodeMirrorEditor
        
        if (cell.model.type === 'code') {
            cell.model.mimeType = 'text/x-ipython'
            const c = cell as CodeCell
            c.model.stateChanged.connect((_s, a) => {
                if (a.name === 'executionCount' && this.hosting) {
                    this.cells.get(cellID).set('tag', a.newValue)
                }

            }, this)
            c.model.outputs.changed.connect((_s, a) => {
                if (a.type === 'add' && this.hosting) {
                    this.updateCellOutput(c)
                }
            }, this)
        }
        const binding = new CodeMirrorBinding(text, editor.editor, this.ws.awareness)
        
        if (this.bindings.get(cellID) !== undefined) {
            this.bindings.get(cellID).destroy()
        }
        this.bindings.set(cellID, binding)
    }


    private updateCellOutput(cell: CodeCell) {
        cell.setPrompt('')
        const cellID = cell.model.metadata.get('rtc-id') as string
        const metadata = this.cells.get(cellID) as Y.Map<any>
        const outputs = new Array() as Array<IOutput>
        for (let index = 0; index < cell.outputArea.model.length; index++) {

            const o = cell.outputArea.model.get(index) as IOutputModel;
            outputs.push(o.toJSON())
        }
        metadata.set('output', outputs)
    }

    private handleOutputChange(id: string) {
        const metadata = this.cells.get(id) as Y.Map<any>
        const cell = this.notebook.widgets[this.getCellIndex(id)]
        if (cell.model.type === 'code') {
            const codeCell = cell as CodeCell
            const outputs = metadata.get('output') as IOutput[]
            codeCell.outputArea.model.clear(false)
            outputs.forEach(output => {
                codeCell.outputArea.model.add(output)
            });
        }
    }

    private handleTag(id: string) {
        const metadata = this.cells.get(id) as Y.Map<any>
        const cell = this.notebook.widgets[this.getCellIndex(id)]
        cell.setPrompt(metadata.get('tag'))
    }

    private handleExecution(e: Y.YMapEvent<any>) {
        const id = e.path[0] as string
        const cell = this.notebook.widgets[this.getCellIndex(id)] as CodeCell
        const currentVal = this.cells.get(id).get('xCount') as number
        if (cell.model.metadata.get('xCount') === currentVal) {
            return
        }
        CodeCell.execute(cell, this.panel.sessionContext)
    }


    private handleMoveUpdate(e: Y.YMapEvent<string>) {
        e.changes.keys.forEach((change) => {
            const id = e.path[0] as string
            let oldPosition = change.oldValue
            const newPosition = this.cells.get(id).get('position') as number

            if (this.notebook.model.cells.get(newPosition).metadata.get('rtc-id') === id) {
                // This cell is already at it's correct position
                return
            }
            this.notebook.model.cells.move(oldPosition, newPosition)
        })
    }

    private adjustIndexes(oldPos: number, newPos: number) {
        let start: number
        let end: number
        if (oldPos <= newPos) {
            start = oldPos
            end = newPos
        }
        if (oldPos > newPos) {
            start = newPos
            end = oldPos
        }

        for (let index = start; index <= end; index++) {
            const id = this.notebook.model.cells.get(index).metadata.get('rtc-id') as string
            const metadata = this.cells.get(id)
            metadata.set('position', index)
        }
    }




    private getCellIndex(cellID: string) {
        return this.cells.get(cellID).get('position') as number
    }

    private hostChangeListener() {
        this.doc.getText('host').observe((e, t) => {
            e.changes.delta.forEach(delta => {
                if (delta.insert) {
                    this.panel.content.model.metadata.set('owner', delta.insert)
                    if (delta.insert === this.username) {
                        this.becomeHost()
                    }
                }
            });
        })
    }

    private becomeHost() {
        this.hosting = true
        this.panel.sessionContext.changeKernel({ name: 'python3' })
    }

    private showSaveDialog() {
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
