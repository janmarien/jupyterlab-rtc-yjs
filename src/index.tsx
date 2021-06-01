
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
import { INotebookModel, NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
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
  requires: [IFileBrowserFactory, INotebookTracker],
  optional: [ILauncher],
  activate: (app: JupyterFrontEnd, filebrowser: IFileBrowserFactory, notebookTracker: INotebookTracker, launcher: ILauncher, ) => {
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

function connectToRTCNotebook(app: JupyterFrontEnd, rtcID: string, path: string) {
  const host = app.serviceManager.serverSettings.baseUrl.split('/')[2].split(':')[0]
  const user = app.serviceManager.serverSettings.baseUrl.split('/')[4]
  app.commands.execute('notebook:create-new', {
    cwd: path,
    kernelName: 'python3'
  }).then((panel: NotebookPanel) => {
    const spinner = new Spinner()
    panel.node.appendChild(spinner.node)
    panel.context.ready.then(() => {
      panel.content.model.metadata.set('rtc-id', rtcID)
      panel.context.save()
    })
    loadRTCNotebook(panel, rtcID, spinner, host, user)
  })

}

function loadRTCNotebook(panel: NotebookPanel, rtcID: string, spinner: Spinner, host: string, user: string) {
  RTCNotebook.connect(panel, rtcID, host, user)
  spinner.hide()
  spinner.dispose()

}

class RTCButton implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel> {
  host: string
  user: string
  constructor(app: JupyterFrontEnd) {
    this.host = app.serviceManager.serverSettings.baseUrl.split('/')[2].split(':')[0]
    this.user = app.serviceManager.serverSettings.baseUrl.split('/')[4]
  }


  createNew(panel: NotebookPanel, context: DocumentRegistry.IContext<INotebookModel>): IDisposable {
    let callBack = () => {
      showRTCDialog(panel, this.host, this.user)
    }
    let button = new ToolbarButton({
      className: 'rtcButton',
      icon: icon,
      onClick: callBack,
      tooltip: 'RTC Notebook'
    })
    panel.toolbar.insertItem(0, "RTC", button)
    return new DisposableDelegate(() => {
      button.dispose()
    })
  }
}


function showRTCDialog(panel: NotebookPanel, host: string, user: string) {
  var rtcID = panel.content.model.metadata.get('rtc-id') as string
  if (rtcID === undefined) {
    const rtcNotebook = RTCNotebook.createNew(panel, host, user)
    rtcID = rtcNotebook.id
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