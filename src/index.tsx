/**
 * @author Mariën Jan 
 */

import {
  JupyterFrontEnd, JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { LabIcon } from '@jupyterlab/ui-components'
import { Dialog, InputDialog, showDialog, Spinner, ToolbarButton } from '@jupyterlab/apputils'
import { ILauncher } from '@jupyterlab/launcher'
import { RTCNotebook } from './RTCNotebook'


import iconString from '../style/share.svg'
import iconActiveString from '../style/share_active.svg'
import pngString from '../style/share_active.png'
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { INotebookModel, NotebookPanel} from '@jupyterlab/notebook';
import { DisposableDelegate, IDisposable } from '@lumino/disposable';
import { Panel, PanelLayout } from '@lumino/widgets'
import { IFileBrowserFactory } from '@jupyterlab/filebrowser'

const icon = new LabIcon({
  name: 'rtc-icon',
  svgstr: iconString,
})

const iconActive = new LabIcon({
  name: 'rtc-icon-active',
  svgstr: iconActiveString,
})


const plugins: JupyterFrontEndPlugin<void> = {
  id: 'rtc',
  autoStart: true,
  requires: [IFileBrowserFactory],
  optional: [ILauncher],
  activate: (app: JupyterFrontEnd, filebrowser: IFileBrowserFactory, launcher: ILauncher, ) => {
    const command: string = 'rtc:startNotebook'
    const command2: string = 'rtc:loadNotebook'
    app.docRegistry.addWidgetExtension('Notebook', new RTCButton(app));
    app.commands.addCommand(command, {
      'label': 'Connect to notebook',
      icon: iconActive,
      execute: args => {
        InputDialog.getText({
          title: 'RTC',
          label: 'Please enter the id of the notebook'
        }).then(result => {
          const cwd = args['cwd'] as string || filebrowser.defaultBrowser.model.path as string;
          connectToRTCNotebook(app, result.value, cwd)
        })
      }
    })
    
    app.commands.addCommand(command2, {
      'label': 'Open shared notebook',
      icon: iconActive,
      execute: args => {
        app.commands.execute('docmanager:open', {
          path: 'testfile.ipynb'
        }).then((panel: NotebookPanel) => {
          panel.context.ready.then(() => {
            const host = app.serviceManager.serverSettings.baseUrl.split('/')[2].split(':')[0]
            const user = app.serviceManager.serverSettings.baseUrl.split('/')[4]
            const id = panel.content.model.metadata.get('rtc-id') as string
            RTCNotebook.load(panel, id, host, user)
          })
        })
      }
    })

    if (launcher) {
      launcher.add({
        command,
        category: 'Notebook',
        kernelIconUrl: pngString,
        rank: 1,
      })
      launcher.add({
        command: command2,
        category: 'Notebook',
        kernelIconUrl: pngString,
        rank: 2
      })
    }
  }
}

/**
 * Initialise a new notebook file and connect it to the shared notebook
 * @param {JupyterFrontEnd} app JupyterLab frontend
 * @param {string} notebookID ID of the shared notebook
 * @param {string} path Local path where to store the notebook file 
 */
function connectToRTCNotebook(app: JupyterFrontEnd, notebookID: string, path: string) {
  const host = app.serviceManager.serverSettings.baseUrl.split('/')[2].split(':')[0]
  const user = app.serviceManager.serverSettings.baseUrl.split('/')[4]
  app.commands.execute('notebook:create-new', {
    cwd: path,
    kernelName: 'python3'
  }).then((panel: NotebookPanel) => {
    const spinner = new Spinner()
    panel.node.appendChild(spinner.node)
    panel.context.ready.then(() => {
      panel.content.model.metadata.set('rtc-id', notebookID)
      panel.context.save()
    })
    loadRTCNotebook(panel, notebookID, spinner, host, user)
  })

}

/**
 * Connect to a shared notebook
 * @param {NotebookPanel} panel 
 * @param {string} rtcID 
 * @param {Spinner} spinner 
 * @param {string} host 
 * @param {string} user 
 */
function loadRTCNotebook(panel: NotebookPanel, rtcID: string, spinner: Spinner, host: string, user: string) {
  RTCNotebook.connect(panel, rtcID, host, user)
  spinner.hide()
  spinner.dispose()

}

/**
 * Class representing the button used to shared a notebook
 */
class RTCButton implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel> {
  _hubHost: string
  _hubUser: string
  constructor(app: JupyterFrontEnd) {
    this._hubHost = app.serviceManager.serverSettings.baseUrl.split('/')[2].split(':')[0]
    this._hubUser = app.serviceManager.serverSettings.baseUrl.split('/')[4]
  }


  /**
   * Creates a new button and inserts it into the Notebookpanel's toolbar
   * @param {NotebookPanel} panel Panel hosting the notebook
   * @param {DocumentRegistry.IContext<INotebookModel>} _context Ignored
   * @returns {IDisposable}
   */
  createNew(panel: NotebookPanel, _context: DocumentRegistry.IContext<INotebookModel>): IDisposable {
    let callBack = () => {
      showRTCDialog(panel, this._hubHost, this._hubUser)
    }
    let button = new ToolbarButton({
      className: 'rtcButton',
      icon: icon,
      onClick: callBack,
      tooltip: 'Share notebook'
    })
    panel.toolbar.insertItem(0, "RTC", button)
    return new DisposableDelegate(() => {
      button.dispose()
    })
  }
}


/**
 * Intialises a shared notebook and displays a dialog which contains the shared id
 * @param {NotebookPanel} panel Notebookpanel hosting the notebook
 * @param {string} hubHost JupyterHub host
 * @param {string} hubUser JupyterHub username
 */
function showRTCDialog(panel: NotebookPanel, hubHost: string, hubUser: string) {
  // Check whether the notebook already has a shared id
  var rtcID = panel.content.model.metadata.get('rtc-id') as string
  if (rtcID === undefined) {
    const rtcNotebook = RTCNotebook.createNew(panel, hubHost, hubUser)
    rtcID = rtcNotebook.notebookID
  }
  
  const body = new Panel()
  const spinner = new Spinner()
  const layout = new PanelLayout()
  layout.addWidget(body)
  const br1 = document.createElement('br')
  body.node.appendChild(br1)
  body.node.appendChild(spinner.node)
  body.node.appendChild(document.createElement('br'))

  showDialog({
    title: 'RTC ID',
    body: body,
    buttons: [Dialog.okButton()]
  })

  
  spinner.hide()
  const text = document.createElement('p')
  text.append('Use the following id to share this notebook with your fellow collaborators.')
  const idText = document.createElement('b')
  idText.style.setProperty('text-align', 'center')
  idText.append(`${rtcID}`)
  body.node.removeChild(br1)
  body.node.appendChild(text)
  body.node.appendChild(document.createElement('br'))
  body.node.append(idText)

}

export default plugins;