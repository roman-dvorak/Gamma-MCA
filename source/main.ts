/* eslint-disable @typescript-eslint/no-non-null-assertion */
/*

  Gamma MCA: free, open-source web-MCA for gamma spectroscopy
  2022, NuclearPhoenix.- Phoenix1747
  https://nuclearphoenix.xyz

  ===============================

  Long Term Todo:
    - Use Webpack to bundle everything
    - Remove all any types

  Possible Future Improvements:
    - (?) Add dead time correction for cps
    - (?) Add desktop notifications
    - (?) Hotkeys
    - (?) Isotope list: Add grouped display, e.g. show all Bi-214 lines with one click

    - Calibration n-polynomial regression
    - ROI with stats (total counts, max, min, FWHM, range,...)

    - (!) Dark Mode -> Bootstrap v5.3
    - (!) FWHM calculation in peak finder
    - (!) Switch some for loops to for each

  Known Issue:
    - Plot: Gaussian Correlation Filtering still has pretty bad performance
    - Plot: Plotly Update takes forever, but there is no real way to improve it
    - Service Worker: Somehow fetching and caching the hits tracker does not work in Edge for me (hits.seeyoufarm.com). Works fine with FF.

*/

import { SpectrumPlot, SeekClosest } from './plot.js';
import { RawData, NPESv1, NPESv1Spectrum } from './raw-data.js';
import { SerialManager, WebSerial, WebUSBSerial } from './serial.js';
import { WebUSBSerialPort } from './external/webusbserial-min.js'
import { Notification } from './notifications.js';

export interface IsotopeList {
  [key: number]: string | undefined;
}

interface OpenPickerAcceptType {
  description: string,
  accept: {
    [key: string]: string[]
  }
}

export type DataOrder = 'hist' | 'chron';
type CalType = 'a' | 'b' | 'c';
type DataType = 'data' | 'background';
type PortList = (WebSerial | WebUSBSerial | undefined)[];
type DownloadType = 'CAL' | 'XML' | 'JSON' | 'CSV';

export class SpectrumData { // Will hold the measurement data globally.
  data: number[] = [];
  background: number[] = [];
  dataCps: number[] = [];
  backgroundCps: number[] = [];
  dataTime = 1000; // Measurement time in ms
  backgroundTime = 1000; // Measurement time in ms

  getTotalCounts(type: DataType): number {
    return this[type].reduce((acc,curr) => acc + curr, 0);
  }

  addPulseData(type: DataType, newDataArr: number[], adcChannels: number): void {
    if(!this[type].length) this[type] = Array(adcChannels).fill(0);

    for (const value of newDataArr) {
      this[type][value] += 1;
    }
  }

  addHist(type: DataType, newHistArr: number[]): void {
    if(!this[type].length) this[type] = newHistArr;

    for (const index in newHistArr) {
      this[type][index] += newHistArr[index];
    }
  }
}

// Holds all the classes
const spectrumData = new SpectrumData();
const plot = new SpectrumPlot('plot');
const raw = new RawData(1); // 2=raw, 1=hist

// Other "global" vars
const calClick = { a: false, b: false, c: false };
const oldCalVals = { a: '', b: '', c: ''};

let portsAvail: PortList = [];
let refreshRate = 1000; // Delay in ms between serial plot updates
let maxRecTimeEnabled = false;
let maxRecTime = 1800000; // 30 minutes
const REFRESH_META_TIME = 200; // Milliseconds
const CONSOLE_REFRESH = 200; // Milliseconds

let cpsValues: number[] = [];

let isoListURL = 'assets/isotopes_energies_min.json';
const isoList: IsotopeList = {};
let checkNearIso = false;
let maxDist = 100; // Max energy distance to highlight

const APP_VERSION = '2023-02-18';
let localStorageAvailable = false;
let fileSystemWritableAvail = false;
let firstInstall = false;

// Isotope table variables
const isoTableSortDirections = ['none', 'none', 'asc'];
const faSortClasses: {[key: string]: string} = {
  none: 'fa-sort',
  asc: 'fa-sort-up',
  desc: 'fa-sort-down'
};

/*
  Startup of the page
*/
document.body.onload = async function(): Promise<void> {
  localStorageAvailable = 'localStorage' in self; // Test for localStorage, for old browsers

  if (localStorageAvailable) {
    loadSettingsStorage();
    //toggleDarkMode(); // Load from settings
  } 

  if (navigator.serviceWorker) { // Add service worker for PWA
    const reg = await navigator.serviceWorker.register('/service-worker.js'); // Onload async because of this... good? hmmm.

    if (localStorageAvailable) {
      reg.addEventListener('updatefound', () => {
        if (firstInstall) return; // "Update" will always be installed on first load (service worker installation)

        new Notification('updateInstalled'); //popupNotification('update-installed');
      });
    }
  }

  if ('standalone' in window.navigator || window.matchMedia('(display-mode: standalone)').matches) { // Standalone PWA mode
    document.title += ' PWA';
    document.getElementById('main')!.classList.remove('p-1');
  } else { // Default browser window
    document.getElementById('main')!.classList.remove('pb-1');
    document.title += ' web application';
  }

  isoListURL = new URL(isoListURL, window.location.origin).href;

  if (navigator.serial || navigator.usb) { // Web Serial API or fallback Web USB API with FTDx JS driver
    const serErrDiv = document.getElementById('serial-error')!;
    serErrDiv.parentNode!.removeChild(serErrDiv); // Delete Serial Not Supported Warning
    navigator[navigator.serial ? 'serial' : 'usb'].addEventListener('connect', serialConnect);
    navigator[navigator.serial ? 'serial' : 'usb'].addEventListener('disconnect', serialDisconnect);
    listSerial(); // List Available Serial Ports
  } else {
    const serDiv = document.getElementById('serial-div')!;
    serDiv.parentNode!.removeChild(serDiv); // Delete Serial Control Div

    const serSettingsElements = document.getElementsByClassName('ser-settings');
    for (const element of serSettingsElements) { // Disable serial settings
      (<HTMLSelectElement | HTMLButtonElement>element).disabled = true;
    }
    const serControlsElements = document.getElementsByClassName('serial-controls');
    for (const element of serControlsElements) { // Disable serial controls
      (<HTMLSelectElement | HTMLButtonElement>element).disabled = true;
    }
  }

  if ('launchQueue' in window && 'LaunchParams' in window) { // File Handling API
    (<any>window).launchQueue.setConsumer(
      async (launchParams: { files: FileSystemFileHandle[] }) => {
        if (!launchParams.files.length) return;

        const file: File = await launchParams.files[0].getFile();

        const fileEnding = file.name.split('.')[1].toLowerCase();
        const spectrumEndings = ['csv', 'tka', 'xml', 'txt', 'json'];
        if (spectrumEndings.includes(fileEnding)) getFileData(file);
        /* else if (fileEnding === 'json') {
          importCal(file);
        } */
        console.warn('File could not be imported!');
      });
  }

  if (window.FileSystemHandle && 'createWritable' in FileSystemFileHandle.prototype) {
    fileSystemWritableAvail = true;
  }

  resetPlot(); // Set up plot window

  document.getElementById('version-tag')!.innerText += ` ${APP_VERSION}.`;

  if (localStorageAvailable) {
    if (loadJSON('lastVisit') <= 0) {
      new Notification('welcomeMessage'); //popupNotification('welcome-msg');
      firstInstall = true;
    }

    saveJSON('lastVisit', Date.now());
    saveJSON('lastUsedVersion', APP_VERSION);

    const sVal = loadJSON('serialDataMode'); // ids: s1, s2
    const rVal = loadJSON('fileDataMode'); // ids: r1, r2

    if (sVal) {
      const element = <HTMLInputElement>document.getElementById(sVal);
      element.checked = true;
      selectSerialType(element);
    }

    if (rVal) {
      const element = <HTMLInputElement>document.getElementById(rVal);
      element.checked = true;
      selectFileType(element);
    }

    const settingsNotSaveAlert = document.getElementById('ls-unavailable')!; // Remove saving alert
    settingsNotSaveAlert.parentNode!.removeChild(settingsNotSaveAlert);

    const getAutoScrollValue = loadJSON('consoleAutoscrollEnabled');
    if (getAutoScrollValue) {
      autoscrollEnabled = getAutoScrollValue;
      (<HTMLInputElement>document.getElementById('autoscroll-console')).checked = getAutoScrollValue;
    }
  } else {
    const settingsSaveAlert = document.getElementById('ls-available')!; // Remove saving alert
    settingsSaveAlert.parentNode!.removeChild(settingsSaveAlert);
    new Notification('welcomeMessage'); //popupNotification('welcome-msg');
  }

  loadSettingsDefault();
  sizeCheck();

  bindInputs(); // Enable settings enter press and onclick buttons

  const menuElements = document.getElementById('main-tabs')!.getElementsByTagName('button');
  for (const button of menuElements) {
    button.addEventListener('shown.bs.tab', (event: Event): void => {
      const toggleCalChartElement = <HTMLInputElement>document.getElementById('toggle-calibration-chart');

      if ((<HTMLButtonElement>event.target).id !== 'calibration-tab' && toggleCalChartElement.checked) { // Leave cal chart when leaving cal tab
        toggleCalChartElement.checked = false;
        toggleCalChart(false);
      } else {
        plot.updatePlot(spectrumData); // Adjust Plot Size For Main Tab Menu Content Size
      }
    });
  }

  const isoTable = <HTMLTableElement>document.getElementById('table');
  
  const thList = <NodeListOf<HTMLTableCellElement>>isoTable.querySelectorAll('th[data-sort-by]'); // Add click event listeners to table header cells
  thList.forEach(th => {
    th.addEventListener('click', () => {
      const columnIndex = Number(th.dataset.sortBy);
      const sortDirection = isoTableSortDirections[columnIndex];

      // Toggle the sort direction
      isoTableSortDirections.fill('none');
      isoTableSortDirections[columnIndex] = sortDirection === 'asc' ? 'desc' : 'asc';

      thList.forEach((loopTableHeader, index) => {
        const sortIcon = <HTMLElement>loopTableHeader.querySelector('.fa-solid');

        sortIcon.classList.remove(...Object.values(faSortClasses)); // Remove all old icons
        sortIcon.classList.add(faSortClasses[isoTableSortDirections[index+1]]); // Set new icons
      });

      sortTableByColumn(isoTable, columnIndex, isoTableSortDirections[columnIndex]); // Actually sort the table rows
    });
  });

  const loadingSpinner = document.getElementById('loading')!;
  loadingSpinner.parentNode!.removeChild(loadingSpinner); // Delete Loading Thingymajig
};


// Exit website confirmation alert
window.onbeforeunload = (): string => {
  return 'Are you sure to leave?';
};


// Needed For Responsiveness! DO NOT REMOVE OR THE LAYOUT GOES TO SHIT!!!
document.body.onresize = (): void => {
  plot.updatePlot(spectrumData);
  if (navigator.userAgent.toLowerCase().match(/mobile|tablet|android|webos|iphone|ipad|ipod|blackberry|bb|playbook|iemobile|windows phone|kindle|silk|opera mini/i)) {
    // Mobile device
  } else {
    sizeCheck();
  }
};

/*
document.getElementById()!.onclick = () => toggleDarkMode();

function toggleDarkMode(): void {
  const themeElements = document.getElementsByClassName('theme-mode');
  for (const element of themeElements) {
    element.classList.remove('text-bg-light', 'text-bg-white', 'table-light');
    element.classList.add('text-bg-dark'); // TODO: add table-dark
    // TODO: Change font color, reset to light mode, save to settings
  }
}
*/

/*
window.addEventListener('hidden.bs.collapse', (event: Event) => {
  if ((<HTMLButtonElement>event.target).getAttribute('id') === 'collapse-tabs') {
    plot.updatePlot(spectrumData);
  }
});


window.addEventListener('shown.bs.collapse', (event: Event) => {
  if ((<HTMLButtonElement>event.target).getAttribute('id') === 'collapse-tabs') {
    plot.updatePlot(spectrumData);
  }
});
*/

// User changed from browser window to PWA (after installation) or backwards
window.matchMedia('(display-mode: standalone)').addEventListener('change', (/*event*/): void => {
  /*
  let displayMode = 'browser';
  if (event.matches) {
    displayMode = 'standalone';
  }
  */
  window.location.reload(); // Just reload the page?
});


let deferredPrompt: any;

window.addEventListener('beforeinstallprompt', (event: Event): void => {
  event.preventDefault(); // Prevent the mini-infobar from appearing on mobile
  deferredPrompt = event;

  if (localStorageAvailable) {
    if (!loadJSON('installPrompt')) {
      legacyPopupNotification('pwa-installer'); // Show notification on first visit
      saveJSON('installPrompt', true);
    }
  }

  document.getElementById('manual-install')!.classList.remove('d-none');
});


document.getElementById('install-pwa-btn')!.onclick = () => installPWA();
document.getElementById('install-pwa-toast-btn')!.onclick = () => installPWA();

async function installPWA(): Promise<void> {
  //hideNotification('pwa-installer');
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
}


window.addEventListener('onappinstalled', (): void => {
  deferredPrompt = null;
  hideNotification('pwa-installer');
  document.getElementById('manual-install')!.classList.add('d-none');
});

/*
document.onkeydown = async function(event) {
  console.log(event.keyCode);
  if (event.keyCode === 27) { // ESC
    const offcanvasElement = document.getElementById('offcanvas');
    const offcanvas = new bootstrap.Offcanvas(offcanvasElement);

    //event.preventDefault();

    await offcanvas.toggle();
  }
};
*/


document.getElementById('data')!.onclick = event => clickFileInput(event, false);
document.getElementById('background')!.onclick = event => clickFileInput(event, true);

const openFileTypes: OpenPickerAcceptType[] = [
  {
    description: 'Combination Files',
    accept: {
      'application/json': ['.json'],
      'application/xml': ['.xml']
    }
  },
  {
    description: 'Single Spectrum Files',
    accept: {
      'text/csv': ['.csv'],
      'text/txt': ['.txt'],
      'text/TKA': ['.TKA']
    }
  }
];
let dataFileHandle: FileSystemFileHandle | undefined;
let backgroundFileHandle: FileSystemFileHandle | undefined;

async function clickFileInput(event: MouseEvent, background: boolean): Promise<void> {
  //(<HTMLInputElement>event.target).value = ''; // No longer necessary?

  if (window.FileSystemHandle && window.showOpenFilePicker) { // Try to use the File System Access API if possible
    event.preventDefault(); // Don't show the "standard" HTML file picker...

    const openFilePickerOptions = {
      types: openFileTypes,
      multiple: false
    };

    let fileHandle: FileSystemFileHandle;

    try {
      [fileHandle] = await window.showOpenFilePicker(openFilePickerOptions); // ...instead show a File System Access API picker
    } catch (error) {
      console.warn('File Picker error:', error);
      return;
    }
    
    const file = await fileHandle.getFile();

    if (background) {
      getFileData(file, true);
    } else {
      getFileData(file, false);
    }

    const fileExtension = file.name.split('.')[1].toLowerCase();

    if (fileExtension !== 'json' && fileExtension !== 'xml') {
      //console.info('The "Save" action is not supported on the imported file.');
      return;
    }

    // File System Access API specific stuff
    if (background) {
      backgroundFileHandle = fileHandle;
    } else {
      dataFileHandle = fileHandle;
    }

    if (fileSystemWritableAvail) { // Only enable if it can be used
      (<HTMLButtonElement>document.getElementById('overwrite-button')).disabled = false;
    }
  }
}


document.getElementById('data')!.onchange = event => importFile(<HTMLInputElement>event.target);
document.getElementById('background')!.onchange = event => importFile(<HTMLInputElement>event.target, true);

function importFile(input: HTMLInputElement, background = false): void {
  if (!input.files?.length) return; // File selection has been canceled
  getFileData(input.files[0], background);
}


function getFileData(file: File, background = false): void { // Gets called when a file has been selected.
  const reader = new FileReader();

  const fileEnding = file.name.split('.')[1];

  document.getElementById(`${background ? 'background' : 'data'}-form-label`)!.innerText = file.name; // Set file name

  reader.readAsText(file);

  reader.onload = async () => {
    const result = (<string>reader.result).trim(); // A bit unclean for typescript, I'm sorry

    if (fileEnding.toLowerCase() === 'xml') {
      if (window.DOMParser) {
        const {espectrum, bgspectrum, coeff, meta} = raw.xmlToArray(result);

        (<HTMLInputElement>document.getElementById('sample-name')).value = meta.name;
        (<HTMLInputElement>document.getElementById('sample-loc')).value = meta.location;

        if (meta.time) {
          const date = new Date(meta.time);
          const rightDate = new Date(date.getTime() - date.getTimezoneOffset()*60*1000);
          (<HTMLInputElement>document.getElementById('sample-time')).value = rightDate.toISOString().slice(0,16);
        }

        (<HTMLInputElement>document.getElementById('sample-vol')).value = meta.volume?.toString() ?? '';
        (<HTMLInputElement>document.getElementById('sample-weight')).value = meta.weight?.toString() ?? '';
        (<HTMLInputElement>document.getElementById('device-name')).value = meta.deviceName;
        (<HTMLInputElement>document.getElementById('add-notes')).value = meta.notes;

        startDate = new Date(meta.startTime);
        endDate = new Date(meta.endTime);

        if (espectrum?.length && bgspectrum?.length) { // Both files ok
          spectrumData.data = espectrum;
          spectrumData.background = bgspectrum;
          spectrumData.dataTime = meta.dataMt*1000;
          spectrumData.backgroundTime = meta.backgroundMt*1000;
        
          if (meta.dataMt) spectrumData.dataCps = spectrumData.data.map(val => val / meta.dataMt);
          if (meta.backgroundMt) spectrumData.backgroundCps = spectrumData.background.map(val => val / meta.backgroundMt);

        } else if (!espectrum?.length && !bgspectrum?.length) { // No spectrum
          new Notification('fileError'); //popupNotification('file-error');
        } else { // Only one spectrum
          const fileData = espectrum?.length ? espectrum : bgspectrum;
          const fileDataTime = (espectrum?.length ? meta.dataMt : meta.backgroundMt)*1000;
          const fileDataType = background ? 'background' : 'data';

          spectrumData[fileDataType] = fileData;
          spectrumData[`${fileDataType}Time`] = fileDataTime;
          
          if (fileDataTime) spectrumData[`${fileDataType}Cps`] = spectrumData[fileDataType].map(val => val / fileDataTime * 1000);
        }

        const importedCount = Object.values(coeff).filter(value => value !== 0).length;

        if (importedCount >= 2) {
          resetCal(); // Reset in case of old calibration
          plot.calibration.coeff = coeff;
          plot.calibration.imported = true;
          displayCoeffs();

          const calSettings = document.getElementsByClassName('cal-setting');
          for (const element of calSettings) {
            (<HTMLInputElement>element).disabled = true;
          }

          addImportLabel();
        }
      } else {
        console.error('No DOM parser in this browser!');
      }
    } else if (fileEnding.toLowerCase() === 'json') { // THIS SECTION MAKES EVERYTHING ASYNC!!!
      const importData = await raw.jsonToObject(result);

      if (!importData) { // Data does not validate the schema
        new Notification('npesError'); //popupNotification('npes-error');
        return;
      }

      (<HTMLInputElement>document.getElementById('device-name')).value = importData?.deviceData?.deviceName ?? '';
      (<HTMLInputElement>document.getElementById('sample-name')).value = importData?.sampleInfo?.name ?? '';
      (<HTMLInputElement>document.getElementById('sample-loc')).value = importData?.sampleInfo?.location ?? '';

      if (importData.sampleInfo?.time) {
        const date = new Date(importData.sampleInfo.time);
        const rightDate = new Date(date.getTime() - date.getTimezoneOffset()*60*1000);

        (<HTMLInputElement>document.getElementById('sample-time')).value = rightDate.toISOString().slice(0,16);
      }

      (<HTMLInputElement>document.getElementById('sample-weight')).value = importData.sampleInfo?.weight?.toString() ?? '';
      (<HTMLInputElement>document.getElementById('sample-vol')).value = importData.sampleInfo?.volume?.toString() ?? '';
      (<HTMLInputElement>document.getElementById('add-notes')).value = importData.sampleInfo?.note ?? '';

      const resultData = importData.resultData;

      if (resultData.startTime && resultData.endTime) {
        startDate = new Date(resultData.startTime);
        endDate = new Date(resultData.endTime);
      }

      const espectrum = resultData.energySpectrum;
      const bgspectrum = resultData.backgroundEnergySpectrum;
      if (espectrum && bgspectrum) { // Both files ok
        spectrumData.data = espectrum.spectrum;
        spectrumData.background = bgspectrum.spectrum;

        const eMeasurementTime = espectrum.measurementTime;
        if (eMeasurementTime) {
          spectrumData.dataTime = eMeasurementTime * 1000;
          spectrumData.dataCps = spectrumData.data.map(val => val / eMeasurementTime);
        }
        const bgMeasurementTime = bgspectrum.measurementTime;
        if (bgMeasurementTime) {
          spectrumData.backgroundTime = bgMeasurementTime * 1000;
          spectrumData.backgroundCps = spectrumData.background.map(val => val / bgMeasurementTime);
        }
      } else { // Only one spectrum
        const dataObj = espectrum ?? bgspectrum;
        const fileData = dataObj?.spectrum ?? [];
        const fileDataTime = (dataObj?.measurementTime ?? 1) * 1000;
        const fileDataType = background ? 'background' : 'data';

        spectrumData[fileDataType] = fileData;
        spectrumData[`${fileDataType}Time`] = fileDataTime;
        
        if (fileDataTime) spectrumData[`${fileDataType}Cps`] = spectrumData[fileDataType].map(val => val / fileDataTime * 1000);
      }

      const calDataObj = (espectrum ?? bgspectrum)?.energyCalibration; // Grab calibration preferably from energy spectrum

      if (calDataObj) {
        const coeffArray: number[] = calDataObj.coefficients;
        const numCoeff: number = calDataObj.polynomialOrder;

        resetCal(); // Reset in case of old calibration

        for (const index in coeffArray) {
          plot.calibration.coeff[`c${numCoeff-parseInt(index)+1}`] = coeffArray[index];
        }
        plot.calibration.imported = true;
        displayCoeffs();

        const calSettings = document.getElementsByClassName('cal-setting');
        for (const element of calSettings) {
          (<HTMLInputElement>element).disabled = true;
        }
        addImportLabel();
      }
    } else if (background) {
      spectrumData.backgroundTime = 1000;
      spectrumData.background = raw.csvToArray(result);
    } else {
      spectrumData.dataTime = 1000;
      spectrumData.data = raw.csvToArray(result);
    }

    updateSpectrumCounts();
    updateSpectrumTime();

    /*
      Error Msg Problem with RAW Stream selection?
    */
    if (spectrumData.background.length !== spectrumData.data.length && spectrumData.data.length && spectrumData.background.length) {
      new Notification('dataError'); //popupNotification('data-error');
      removeFile(background ? 'background' : 'data'); // Remove file again
    }

    plot.resetPlot(spectrumData);
    bindPlotEvents();
  };

  reader.onerror = () => {
    new Notification('fileError'); //popupNotification('file-error');
    return;
  };
}


function sizeCheck(): void {
  const minWidth = 1100;
  const minHeight = 700;
  if (document.documentElement.clientWidth <= minWidth || document.documentElement.clientHeight <= minHeight) {
    console.warn(`Small screen detected. Screen should be at least ${minWidth}x${minHeight} px for the best experience.`)
  }
}


document.getElementById('clear-data')!.onclick = () => removeFile('data');
document.getElementById('clear-bg')!.onclick = () => removeFile('background');

function removeFile(id: DataType): void {
  spectrumData[id] = [];
  spectrumData[`${id}Time`] = 0;
  (<HTMLInputElement>document.getElementById(id)).value = '';
  document.getElementById(`${id}-form-label`)!.innerText = 'No File Chosen';

  if (id === 'data') dataFileHandle = undefined; // Reset File System Access API handlers
  if (id === 'background') backgroundFileHandle = undefined;
  if (!dataFileHandle && !backgroundFileHandle && fileSystemWritableAvail) {
    (<HTMLButtonElement>document.getElementById('overwrite-button')).disabled = true; // Disable save button again, if it could be used
  }

  updateSpectrumCounts();
  updateSpectrumTime();

  document.getElementById(id + '-icon')!.classList.add('d-none');

  plot.resetPlot(spectrumData);
  bindPlotEvents();
}


function addImportLabel(): void {
  document.getElementById('calibration-title')!.classList.remove('d-none');
}


function updateSpectrumCounts() {
  const sCounts = spectrumData.getTotalCounts('data');
  const bgCounts = spectrumData.getTotalCounts('background');

  document.getElementById('total-spec-cts')!.innerText = sCounts.toString() + ' cts';
  document.getElementById('total-bg-cts')!.innerText = bgCounts.toString() + ' cts';

  if (sCounts) document.getElementById('data-icon')!.classList.remove('d-none');
  if (bgCounts) document.getElementById('background-icon')!.classList.remove('d-none');
}


function updateSpectrumTime() {
  document.getElementById('spec-time')!.innerText = getRecordTimeStamp(spectrumData.dataTime);
  document.getElementById('bg-time')!.innerText = getRecordTimeStamp(spectrumData.backgroundTime);
}


document.getElementById('r1')!.onchange = event => selectFileType(<HTMLInputElement>event.target);
document.getElementById('r2')!.onchange = event => selectFileType(<HTMLInputElement>event.target);

function selectFileType(button: HTMLInputElement): void {
  raw.fileType = parseInt(button.value);
  raw.valueIndex = parseInt(button.value);
  saveJSON('fileDataMode', button.id);
}


document.getElementById('reset-plot')!.onclick = () => resetPlot();

function resetPlot(): void {
  if (plot.xAxis === 'log') changeAxis(<HTMLButtonElement>document.getElementById('xAxis'));
  if (plot.yAxis === 'log') changeAxis(<HTMLButtonElement>document.getElementById('yAxis'));
  if (plot.sma) toggleSma(false, <HTMLInputElement>document.getElementById('sma'));

  plot.clearAnnos();
  (<HTMLInputElement>document.getElementById('check-all-isos')).checked = false; // reset "select all" checkbox
  loadIsotopes(true); // Plot resets all isotope lines, but they stay checked if not force reloaded
  plot.resetPlot(spectrumData);
  bindPlotEvents(); // Fix Reset Bug: Hovering and Clicking not working.
}


document.getElementById('xAxis')!.onclick = event => changeAxis(<HTMLButtonElement>event.target);
document.getElementById('yAxis')!.onclick = event => changeAxis(<HTMLButtonElement>event.target);

function changeAxis(button: HTMLButtonElement): void {
  const id = button.id as 'xAxis' | 'yAxis';
  if (plot[id] === 'linear') {
    plot[id] = 'log';
    button.innerText = 'Log';
    plot.resetPlot(spectrumData); // Fix because of autorange bug in Plotly
    bindPlotEvents();
  } else {
    plot[id] = 'linear';
    button.innerText = 'Linear';
    plot.updatePlot(spectrumData);
  }
}


document.getElementById('sma')!.onclick = event => toggleSma((<HTMLInputElement>event.target).checked);

function toggleSma(value: boolean, thisValue: HTMLInputElement | null = null ): void {
  plot.sma = value;
  if (thisValue) thisValue.checked = false;
  plot.updatePlot(spectrumData);
}


document.getElementById('smaVal')!.oninput = event => changeSma(<HTMLInputElement>event.target);

function changeSma(input: HTMLInputElement): void {
  const parsedInput = parseInt(input.value);
  if (isNaN(parsedInput)) {
    new Notification('smaError'); //popupNotification('sma-error');
  } else {
    plot.smaLength = parsedInput;
    plot.updatePlot(spectrumData);
    saveJSON('smaLength', parsedInput);
  }
}


function bindPlotEvents(): void {
  if (!plot.plotDiv) return;

  const myPlot = <any>plot.plotDiv; 
  myPlot.on('plotly_hover', hoverEvent);
  myPlot.on('plotly_unhover', unHover);
  myPlot.on('plotly_click', clickEvent);
  myPlot.on('plotly_webglcontextlost', webGLcontextLoss);
  myPlot.addEventListener('contextmenu', (event: PointerEvent) => {
    event.preventDefault(); // Prevent the context menu from opening inside the plot!
  });
}


function hoverEvent(data: any): void {
  for (const key in calClick) {
    const castKey = <CalType>key;
    if (calClick[castKey]) (<HTMLInputElement>document.getElementById(`adc-${castKey}`)).value = data.points[0].x.toFixed(2);
  }

  if (checkNearIso) closestIso(data.points[0].x);
}


function unHover(/*data: any*/): void {
  for (const key in calClick) {
    const castKey = <CalType>key;
    if (calClick[castKey]) (<HTMLInputElement>document.getElementById(`adc-${castKey}`)).value = oldCalVals[castKey];
  }
  /*
  if (Object.keys(prevIso).length > 0) {
    closestIso(-maxDist); // Force Reset Iso Highlighting
  }
  */
}


let prevClickLine: number | undefined;

function clickEvent(data: any): void {
  document.getElementById('click-data')!.innerText = data.points[0].x.toFixed(2) + data.points[0].xaxis.ticksuffix + ': ' + data.points[0].y.toFixed(2) + data.points[0].yaxis.ticksuffix;

  for (const key in calClick) {
    const castKey = <CalType>key;
    if (calClick[castKey]) {
      (<HTMLInputElement>document.getElementById(`adc-${castKey}`)).value = data.points[0].x.toFixed(2);
      oldCalVals[castKey] = data.points[0].x.toFixed(2);
      calClick[castKey] = false;
      (<HTMLInputElement>document.getElementById(`select-${castKey}`)).checked = calClick[<CalType>key];
    }
  }

  if (data.event.which === 1) { // Left-click. spawn a line in the plot and delete the last line
    if (prevClickLine) plot.toggleLine(prevClickLine, prevClickLine.toString(), false);
    const newLine: number = Math.round(data.points[0].x);
    plot.toggleLine(newLine, newLine.toString(), true);
    prevClickLine = newLine;
  } else if (data.event.which === 3) { // Right-click, delete all clicked lines
    if (prevClickLine) plot.toggleLine(prevClickLine, prevClickLine.toString(), false);
    prevClickLine = undefined;
  }
  plot.updatePlot(spectrumData);
}


function webGLcontextLoss(): void {
  console.error('Lost WebGL context for Plotly.js! Falling back to default SVG render mode...');
  plot.fallbackGL = true;
  plot.resetPlot(spectrumData);
  bindPlotEvents();
}


document.getElementById('apply-cal')!.onclick = event => toggleCal((<HTMLInputElement>event.target).checked);

function toggleCal(enabled: boolean): void {
  const button = document.getElementById('calibration-label')!;

  button.innerHTML = enabled ? '<i class="fa-solid fa-rotate-left"></i> Reset' : '<i class="fa-solid fa-check"></i> Calibrate';
  /*
    Reset Plot beforehand, to prevent x-range from dying when zoomed?
  */
  if (enabled) {
    if (!plot.calibration.imported) {

      const readoutArray = [
        [(<HTMLInputElement>document.getElementById('adc-a')).value, (<HTMLInputElement>document.getElementById('cal-a')).value],
        [(<HTMLInputElement>document.getElementById('adc-b')).value, (<HTMLInputElement>document.getElementById('cal-b')).value],
        [(<HTMLInputElement>document.getElementById('adc-c')).value, (<HTMLInputElement>document.getElementById('cal-c')).value]
      ];

      let invalid = 0;
      const validArray: number[][] = [];

      for (const pair of readoutArray) {
        const float1 = parseFloat(pair[0]);
        const float2 = parseFloat(pair[1]);

        if (isNaN(float1) || isNaN(float2)) {
          //validArray.push([-1, -1]);
          invalid += 1;
        } else {
          validArray.push([float1, float2]);
        }
        if (invalid > 1) {
          new Notification('calibrationApplyError'); //popupNotification('cal-error');

          const checkbox = <HTMLInputElement>document.getElementById('apply-cal');
          checkbox.checked = false;
          toggleCal(checkbox.checked);

          return;
        }
      }

      plot.calibration.points.aFrom = validArray[0][0];
      plot.calibration.points.aTo = validArray[0][1];
      plot.calibration.points.bFrom = validArray[1][0];
      plot.calibration.points.bTo = validArray[1][1];

      if (validArray.length === 3) {
        plot.calibration.points.cTo = validArray[2][1];
        plot.calibration.points.cFrom = validArray[2][0];
      } else {
        delete plot.calibration.points.cTo;
        delete plot.calibration.points.cFrom;
      }

      plot.computeCoefficients();
    }
  }
  displayCoeffs();

  plot.calibration.enabled = enabled;
  plot.resetPlot(spectrumData); // Fix because of autorange bug in Plotly
  bindPlotEvents();
}


function displayCoeffs(): void {
  for (const elem of ['c1','c2','c3']) {
    document.getElementById(`${elem}-coeff`)!.innerText = plot.calibration.coeff[elem].toString();
  }
}


document.getElementById('calibration-reset')!.onclick = () => resetCal();

function resetCal(): void {
  for (const point in calClick) {
    calClick[<CalType>point] = false;
  }

  const calSettings = document.getElementsByClassName('cal-setting');
  for (const element of <HTMLCollectionOf<HTMLInputElement>>calSettings) {
    element.disabled = false;
    element.value = '';
  }

  document.getElementById('calibration-title')!.classList.add('d-none');

  plot.clearCalibration();
  toggleCal(false);
}


// Pretty ugly, but will get changed when implementing the n-poly calibration
document.getElementById('select-a')!.onclick = event => toggleCalClick('a', (<HTMLInputElement>event.target).checked);
document.getElementById('select-b')!.onclick = event => toggleCalClick('b', (<HTMLInputElement>event.target).checked);
document.getElementById('select-c')!.onclick = event => toggleCalClick('c', (<HTMLInputElement>event.target).checked);

function toggleCalClick(point: CalType, value: boolean): void {
  calClick[point] = value;
}


document.getElementById('plotType')!.onclick = () => changeType();

function changeType(): void {
  const button = <HTMLButtonElement>document.getElementById('plotType');
  if (plot.linePlot) {
    button.innerHTML = '<i class="fas fa-chart-bar"></i> Bar';
  } else {
    button.innerHTML = '<i class="fas fa-chart-line"></i> Line';
  }
  plot.linePlot = !plot.linePlot;
  plot.updatePlot(spectrumData);
}


document.getElementById('plot-cps')!.onclick = event => toggleCps(<HTMLButtonElement>event.target);

function toggleCps(button: HTMLButtonElement): void {
  plot.cps = !plot.cps;

  button.innerText = plot.cps ? 'CPS' : 'Total';
  plot.updatePlot(spectrumData);
}


document.getElementById('cal-input')!.onchange = event => importCalButton(<HTMLInputElement>event.target);

function importCalButton(input: HTMLInputElement): void {
  if (!input.files?.length) return; // File selection has been canceled
  importCal(input.files[0]);
}


function importCal(file: File): void {
  const reader = new FileReader();

  reader.readAsText(file);

  reader.onload = () => {
    try {
      const result = (<string>reader.result).trim(); // A bit unclean for typescript, I'm sorry
      const obj = JSON.parse(result);

      const readoutArray = [
        <HTMLInputElement>document.getElementById('adc-a'),
        <HTMLInputElement>document.getElementById('cal-a'),
        <HTMLInputElement>document.getElementById('adc-b'),
        <HTMLInputElement>document.getElementById('cal-b'),
        <HTMLInputElement>document.getElementById('adc-c'),
        <HTMLInputElement>document.getElementById('cal-c')
      ];


      if (obj.imported) {

        const calSettings = document.getElementsByClassName('cal-setting');
        for (const element of calSettings) {
          (<HTMLInputElement>element).disabled = true;
        }

        addImportLabel();

        plot.calibration.coeff = obj.coeff;
        plot.calibration.imported = true;

      } else {

        const inputArr = ['aFrom', 'aTo', 'bFrom', 'bTo', 'cFrom', 'cTo'];
        for (const index in inputArr) {
          if (obj.points === undefined || typeof obj.points === 'number') { // Keep compatability with old calibration files
            readoutArray[index].value = obj[inputArr[index]];
          } else { // New calibration files
            readoutArray[index].value = obj.points[inputArr[index]];
          }
        }

        oldCalVals.a = readoutArray[0].value;
        oldCalVals.b = readoutArray[2].value;
        oldCalVals.c = readoutArray[4].value;
      }

    } catch(e) {
      console.error('Calibration Import Error:', e);
      new Notification('calibrationImportError'); //popupNotification('cal-import-error');
    }
  };

  reader.onerror = () => {
    new Notification('fileError'); //popupNotification('file-error');
    return;
  };
}


document.getElementById('toggle-calibration-chart')!.onclick = event => toggleCalChart((<HTMLInputElement>event.target).checked);

function toggleCalChart(enabled: boolean): void {
  const buttonLabel = document.getElementById('toggle-cal-chart-label')!;
  buttonLabel.innerHTML = enabled ? '<i class="fa-solid fa-eye-slash fa-beat-fade"></i> Hide Chart' : '<i class="fa-solid fa-eye"></i> Show Chart';

  plot.toggleCalibrationChart(spectrumData, enabled);
}


function addLeadingZero(number: string): string {
  if (parseFloat(number) < 10) return '0' + number;
  return number;
}


function getDateString(): string {
  const time = new Date();
  return time.getFullYear() + '-' + addLeadingZero((time.getMonth() + 1).toString()) + '-' + addLeadingZero(time.getDate().toString()) + '_' + addLeadingZero(time.getHours().toString()) + '-' + addLeadingZero(time.getMinutes().toString());
}


function getDateStringMin(): string {
  const time = new Date();
  return time.getFullYear() + '-' + addLeadingZero((time.getMonth() + 1).toString()) + '-' + addLeadingZero(time.getDate().toString());
}


function toLocalIsoString(date: Date) {
  let localIsoString = date.getFullYear() + '-'
    + addLeadingZero((date.getMonth() + 1).toString()) + '-'
    + addLeadingZero(date.getDate().toString()) + 'T'
    + addLeadingZero(date.getHours().toString()) + ':'
    + addLeadingZero(date.getMinutes().toString()) + ':'
    + addLeadingZero(date.getSeconds().toString());

  localIsoString += (-date.getTimezoneOffset() < 0) ? '-' : '+';
  const tzDate = new Date(Math.abs(date.getTimezoneOffset()));

  localIsoString += addLeadingZero(tzDate.getHours().toString()) + ':' + addLeadingZero(tzDate.getMinutes().toString());
  return localIsoString;
}


document.getElementById('calibration-download')!.onclick = () => downloadCal();

function downloadCal(): void {
  const calObj = plot.calibration;
  if (!calObj.points.cFrom) delete calObj.points.cFrom;
  if (!calObj.points.cTo) delete calObj.points.cTo;

  download(`calibration_${getDateString()}.json`, JSON.stringify(calObj), 'CAL');
}


document.getElementById('xml-export-btn')!.onclick = () => downloadXML();

function downloadXML(): void {
  const filename = `spectrum_${getDateString()}.xml`;
  const content = generateXML();
  download(filename, content, 'XML');
}


function makeXMLSpectrum(type: DataType, name: string): Element {
  const root = document.createElementNS(null, (type === 'data') ? 'EnergySpectrum' : 'BackgroundEnergySpectrum');
  const noc = document.createElementNS(null, 'NumberOfChannels');

  noc.textContent = spectrumData[type].length.toString();
  root.appendChild(noc);

  const sn = document.createElementNS(null, 'SpectrumName');
  sn.textContent = name;
  root.appendChild(sn);

  if (plot.calibration.enabled) {
    const ec = document.createElementNS(null, 'EnergyCalibration');
    root.appendChild(ec);

    const c = document.createElementNS(null, 'Coefficients');
    const coeffs: number[] = [];
    const coeffObj = plot.calibration.coeff;

    for (const index in coeffObj) {
      coeffs.push(coeffObj[index]);
    }
    const coeffsRev = coeffs.reverse();
    for (const val of coeffsRev) {
      const coeff = document.createElementNS(null, 'Coefficient');
      coeff.textContent = val.toString();
      c.appendChild(coeff);
    }
    ec.appendChild(c);

    const po = document.createElementNS(null, 'PolynomialOrder');
    /*
    // Specifies the number of coefficients in the XML
    if (plot.calibration.coeff.c1 === 0) {
      po.textContent = (1).toString();
    } else {
      po.textContent = (2).toString();
    }
    */
    po.textContent = (2).toString();
    ec.appendChild(po);
  }

  const tpc = document.createElementNS(null, 'TotalPulseCount');
  tpc.textContent = spectrumData.getTotalCounts(type).toString();
  root.appendChild(tpc);

  const vpc = document.createElementNS(null, 'ValidPulseCount');
  vpc.textContent = tpc.textContent;
  root.appendChild(vpc);

  const mt = document.createElementNS(null, 'MeasurementTime');

  mt.textContent = (Math.round(spectrumData[`${type}Time`]/1000)).toString();
  root.appendChild(mt)

  const s = document.createElementNS(null, 'Spectrum');
  root.appendChild(s);

  for (const datapoint of spectrumData[type]) {
    const d = document.createElementNS(null, 'DataPoint');
    d.textContent = datapoint.toString();
    s.appendChild(d);
  }

  return root;
}


function generateXML(): string {
  const formatVersion = 230124;

  const spectrumName = getDateStringMin() + ' Energy Spectrum';
  const backgroundName = getDateStringMin() + ' Background Energy Spectrum';

  const doc = document.implementation.createDocument(null, 'ResultDataFile');

  const pi = doc.createProcessingInstruction('xml', 'version="1.0" encoding="UTF-8"');
  doc.insertBefore(pi, doc.firstChild);

  const root = doc.documentElement;
  const fv = document.createElementNS(null, 'FormatVersion');
  fv.textContent = formatVersion.toString();
  root.appendChild(fv);

  const rdl = document.createElementNS(null, 'ResultDataList');
  root.appendChild(rdl);

  const rd = document.createElementNS(null, 'ResultData');
  rdl.appendChild(rd);

  const dcr = document.createElementNS(null, 'DeviceConfigReference');
  rd.appendChild(dcr);

  const dcrName = document.createElementNS(null, 'Name');
  /*
  if (serial) {
    dcrName.textContent = 'Gamma MCA Serial Device';
  } else {
    dcrName.textContent = 'Gamma MCA File';
  }
  */
  dcrName.textContent = (<HTMLInputElement>document.getElementById('device-name')).value.trim();
  dcr.appendChild(dcrName);

  if (startDate) {
    const st = document.createElementNS(null, 'StartTime');
    st.textContent = toLocalIsoString(startDate);
    rd.appendChild(st);

    const et = document.createElementNS(null, 'EndTime');
    rd.appendChild(et);

    if (endDate && endDate.getTime() - startDate.getTime() >= 0) {
      et.textContent = toLocalIsoString(endDate);
    } else {
      et.textContent = toLocalIsoString(new Date());
    }
  }

  const si = document.createElementNS(null, 'SampleInfo');
  rd.appendChild(si);

  const name = document.createElementNS(null, 'Name');
  name.textContent = (<HTMLInputElement>document.getElementById('sample-name')).value.trim();
  si.appendChild(name);

  const l = document.createElementNS(null, 'Location');
  l.textContent = (<HTMLInputElement>document.getElementById('sample-loc')).value.trim();
  si.appendChild(l);

  const t = document.createElementNS(null, 'Time');
  const tval = (<HTMLInputElement>document.getElementById('sample-time')).value.trim();
  if (tval.length) {
    t.textContent = toLocalIsoString(new Date(tval));
    si.appendChild(t);
  }

  const w = document.createElementNS(null, 'Weight');
  const wval = (<HTMLInputElement>document.getElementById('sample-weight')).value.trim();
  if (wval.length) {
    w.textContent = (parseFloat(wval)/1000).toString();
    si.appendChild(w);
  }

  const v = document.createElementNS(null, 'Volume');
  const vval = (<HTMLInputElement>document.getElementById('sample-vol')).value.trim();
  if (vval.length) {
    v.textContent = (parseFloat(vval)/1000).toString();
    si.appendChild(v);
  }

  const note = document.createElementNS(null, 'Note');
  note.textContent = (<HTMLInputElement>document.getElementById('add-notes')).value.trim();
  si.appendChild(note);

  if (spectrumData['data'].length) rd.appendChild(makeXMLSpectrum('data', spectrumName));
  if (spectrumData['background'].length) {
    const bsf = document.createElementNS(null, 'BackgroundSpectrumFile');
    bsf.textContent = backgroundName;
    rd.appendChild(bsf);

    rd.appendChild(makeXMLSpectrum('background', backgroundName));
  }

  const vis = document.createElementNS(null, 'Visible');
  vis.textContent = true.toString();
  rd.appendChild(vis);

  return new XMLSerializer().serializeToString(doc);
}


document.getElementById('npes-export-btn')!.onclick = () => downloadNPES();

function downloadNPES(): void {
  const filename = `spectrum_${getDateString()}.json`;
  const data = generateNPES();
  download(filename, JSON.stringify(data), 'JSON');
}


function makeJSONSpectrum(type: DataType): NPESv1Spectrum {
  const spec: NPESv1Spectrum = {
    'numberOfChannels': spectrumData[type].length,
    'validPulseCount': spectrumData.getTotalCounts(type),
    'measurementTime': 0,
    'spectrum': spectrumData[type]
  }
  spec.measurementTime = Math.round(spectrumData[`${type}Time`]/1000);

  if (plot.calibration.enabled) {
    const calObj = {
      'polynomialOrder': 0,
      'coefficients': <number[]>[]
    }
    calObj.polynomialOrder = 2;
    calObj.coefficients = [plot.calibration.coeff.c3, plot.calibration.coeff.c2, plot.calibration.coeff.c1];
    spec.energyCalibration = calObj;
  }

  return spec;
}


function generateNPES(): string | undefined {
  const data: NPESv1 = {
    'schemaVersion': 'NPESv1',
    'deviceData': {
      'softwareName': 'Gamma MCA, ' + APP_VERSION,
      'deviceName': (<HTMLInputElement>document.getElementById('device-name')).value.trim()
    },
    'sampleInfo': {
      'name': (<HTMLInputElement>document.getElementById('sample-name')).value.trim(),
      'location': (<HTMLInputElement>document.getElementById('sample-loc')).value.trim(),
      'note': (<HTMLInputElement>document.getElementById('add-notes')).value.trim()
    },
    'resultData': {}
  }

  let val = parseFloat((<HTMLInputElement>document.getElementById('sample-weight')).value.trim());
  if (val) data.sampleInfo!.weight = val;

  val = parseFloat((<HTMLInputElement>document.getElementById('sample-vol')).value.trim());
  if (val) data.sampleInfo!.volume = val;

  const tval = (<HTMLInputElement>document.getElementById('sample-time')).value.trim();
  if (tval.length && new Date(tval)) data.sampleInfo!.time = toLocalIsoString(new Date(tval));

  if (startDate) {
    data.resultData.startTime = toLocalIsoString(startDate);

    if (endDate && endDate.getTime() - startDate.getTime() >= 0) {
      data.resultData.endTime = toLocalIsoString(endDate);
    } else {
      data.resultData.endTime = toLocalIsoString(new Date());
    }
  }

  if (spectrumData.data.length && spectrumData.getTotalCounts('data')) data.resultData.energySpectrum = makeJSONSpectrum('data');
  if (spectrumData.background.length && spectrumData.getTotalCounts('background')) data.resultData.backgroundEnergySpectrum = makeJSONSpectrum('background');

  // Additionally validate the JSON Schema?
  if (!data.resultData.energySpectrum && !data.resultData.backgroundEnergySpectrum) {
    //new Notification('fileEmptyError'); //popupNotification('file-empty-error');
    return undefined;
  }

  return JSON.stringify(data);
}


document.getElementById('download-spectrum-btn')!.onclick = () => downloadData('spectrum', 'data');
document.getElementById('download-bg-btn')!.onclick = () => downloadData('background', 'background');

function downloadData(filename: string, data: DataType): void {
  filename += `_${getDateString()}.csv`;

  let text = '';
  spectrumData[data].forEach(item => text += item + '\n');

  download(filename, text, 'CSV');
}


document.getElementById('overwrite-button')!.onclick = () => overwriteFile();

async function overwriteFile(): Promise<void> {
  if (dataFileHandle && backgroundFileHandle) {
    new Notification('saveMultipleAtOnce');
    return;
  }

  if (!dataFileHandle && !backgroundFileHandle) {
    console.error('No file handlers found to save to!');
    return;
  } 

  const handler = (dataFileHandle ?? backgroundFileHandle)!; // CANNOT be undefined, since I checked above, ugh...
  const writable = await handler.createWritable(); // Create a FileSystemWritableFileStream to write to.

  const file = await handler.getFile();
  const fileExtension = file.name.split('.')[1].toLowerCase();
  let content: string | undefined;

  if (fileExtension === 'xml') {
    content = generateXML();
  } else {
    content = generateNPES();
  }

  if (!content?.trim()) { // Check empty string
    new Notification('fileEmptyError'); //popupNotification('file-empty-error');
    return;
  }

  await writable.write(content); // Write the contents of the file to the stream.
  await writable.close(); // Close the file and write the contents to disk.
}


const saveFileTypes = {
  'CAL': {
    description: 'Calibration Data File',
    accept: {
      'application/json': ['.json']
    }
  },
  'XML': {
    description: 'Combination Data File',
    accept: {
      'application/xml': ['.xml']
    }
  },
  'JSON': {
    description: 'Combination Data File (NPES)',
    accept: {
      'application/json': ['.json']
    }
  },
  'CSV': {
    description: 'Single Spectrum File',
    accept: {
      'text/csv': ['.csv']
    }
  }
};

async function download(filename: string, text: string, type: DownloadType): Promise<void> {
  if (!text?.trim()) { // Check empty string
    new Notification('fileEmptyError'); //popupNotification('file-empty-error');
    return;
  }

  if (window.FileSystemHandle && window.showSaveFilePicker) { // Try to use File System Access API
    const saveFilePickerOptions = {
      suggestedName: filename,
      types: [saveFileTypes[type]]
    };

    let newHandle: FileSystemFileHandle;

    try {
      newHandle = await window.showSaveFilePicker(saveFilePickerOptions); // Create a new handle
    } catch(error) {
      console.warn('File SaveAs error:', error);
      return;
    }
    
    const writableStream = await newHandle.createWritable(); // Create a FileSystemWritableFileStream to write to

    await writableStream.write(text); // Write our file
    await writableStream.close(); // Close the file and write the contents to disk.
  } else { // Fallback old download-only method
    const element = document.createElement('a');
    element.setAttribute('href', `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`);

    element.setAttribute('download', filename);

    element.style.display = 'none';
    element.click();
  }
}


document.getElementById('reset-meta-values')!.onclick = () => resetSampleInfo();

function resetSampleInfo(): void {
  const toBeReset = <HTMLCollectionOf<HTMLInputElement>>document.getElementsByClassName('sample-info');
  for (const element of toBeReset) {
    element.value = '';
  }
}


function legacyPopupNotification(id: string): void { // Uses Bootstrap Toasts already defined in HTML
  const toast = new (<any>window).bootstrap.Toast(document.getElementById(id));
  if (!toast.isShown()) toast.show();
}


function hideNotification(id: string): void {
  const toast = new (<any>window).bootstrap.Toast(document.getElementById(id));
  if (toast.isShown()) toast.hide();
}


function sortTableByColumn(table: HTMLTableElement, columnIndex: number, sortDirection: string) {
  const tbody = table.tBodies[0];
  const rows = Array.from(tbody.rows);

  rows.sort((a, b) => {
    const aCellValue = a.cells[columnIndex].textContent?.trim() ?? '';
    const bCellValue = b.cells[columnIndex].textContent?.trim() ?? '';

    const aNumValue = parseFloat(aCellValue.replace(/[^\d.-]/g, '')); // Get the mass number of the isotope
    const bNumValue = parseFloat(bCellValue.replace(/[^\d.-]/g, ''));

    if (isNaN(aNumValue) || isNaN(bNumValue)) {
      return aCellValue.localeCompare(bCellValue);
    }

    const comparison = aNumValue - bNumValue;

    return sortDirection === 'asc' ? comparison : -comparison;
  });

  tbody.append(...rows);
}


document.getElementById('toggle-menu')!.onclick = () => loadIsotopes();
document.getElementById('reload-isos-btn')!.onclick = () => loadIsotopes(true);

let loadedIsos = false;

async function loadIsotopes(reload = false): Promise<boolean> { // Load Isotope Energies JSON ONCE
  if (loadedIsos && !reload) return true; // Isotopes already loaded

  const loadingElement = document.getElementById('iso-loading')!;
  loadingElement.classList.remove('d-none');

  const options: RequestInit = {
    cache: 'no-cache',
    headers: {
      'Content-Type': 'text/plain; application/json; charset=UTF-8',
    },
  };


  const isoError = document.getElementById('iso-load-error')!;
  //isoError.innerText = ''; // Remove any old error msges
  isoError.classList.add('d-none'); // Hide any old errors
  let successFlag = true; // Ideally no errors

  try {
    const response = await fetch(isoListURL, options);

    if (response.ok) { // If HTTP-status is 200-299
      const json = await response.json();
      loadedIsos = true;

      const tableElement = <HTMLTableElement>document.getElementById('iso-table');
      tableElement.innerHTML = ''; // Delete old table

      const intKeys = Object.keys(json);
      intKeys.sort((a, b) => parseFloat(a) - parseFloat(b)); // Sort Energies numerically, ascending

      let index = 0; // Index used to avoid HTML id duplicates

      for (const key of intKeys) {
        index++;
        isoList[parseFloat(key)] = json[key];

        const row = tableElement.insertRow();
        const cell1 = row.insertCell(0);
        const cell2 = row.insertCell(1);
        const cell3 = row.insertCell(2);

        cell1.onclick = () => (<HTMLInputElement>cell1.firstChild).click();
        cell2.onclick = () => (<HTMLInputElement>cell1.firstChild).click();
        cell3.onclick = () => (<HTMLInputElement>cell1.firstChild).click();

        cell1.style.cursor = 'pointer'; // Change cursor pointer to "click-ready"
        cell2.style.cursor = 'pointer';
        cell3.style.cursor = 'pointer';

        const energy = parseFloat(key.trim());
        const lowercaseName = json[key].toLowerCase().replace(/[^a-z0-9 -]/gi, '').trim(); // Fixes security issue. Clean everything except for letters, numbers and minus. See GitHub: #2
        const name = lowercaseName.charAt(0).toUpperCase() + lowercaseName.slice(1) + '-' + index; // Capitalize Name and append index number

        cell1.innerHTML = `<input class="form-check-input iso-table-label" id="${name}" type="checkbox" value="${energy}">`;
        cell3.innerText = energy.toFixed(2); //`<label for="${name}">${energy.toFixed(2)}</label>`;

        const clickBox = <HTMLInputElement>document.getElementById(name);
        clickBox.onclick = () => plotIsotope(clickBox);

        const strArr = name.split('-');

        cell2.innerHTML = `<sup>${strArr[1]}</sup>${strArr[0]}`; //`<label for="${name}"><sup>${strArr[1]}</sup>${strArr[0]}</label>`;
      }

      plot.clearAnnos(); // Delete all isotope lines
      plot.updatePlot(spectrumData);
      plot.isoList = isoList; // Copy list to plot object
    } else {
      isoError.innerText = `Could not load isotope list! HTTP Error: ${response.status}. Please try again.`;
      isoError.classList.remove('d-none');
      successFlag = false;
    }
  } catch (err) { // No network connection!
    isoError.innerText = 'Could not load isotope list! Connection refused - you are probably offline.';
    isoError.classList.remove('d-none');
    successFlag = false;
  }

  loadingElement.classList.add('d-none');
  return successFlag;
}


document.getElementById('iso-hover')!.onclick = () => toggleIsoHover();

let prevIso: IsotopeList = {};

function toggleIsoHover(): void {
  checkNearIso = !checkNearIso;
  closestIso(-100000);
}


async function closestIso(value: number): Promise<void> {
  if(!await loadIsotopes()) return; // User has not yet opened the settings panel

  const { energy, name } = new SeekClosest(isoList).seek(value, maxDist);

  //if (Object.keys(prevIso).length >= 0) { // Always true???
  const energyVal = parseFloat(Object.keys(prevIso)[0]);
  if (!isNaN(energyVal)) plot.toggleLine(energyVal, Object.keys(prevIso)[0], false);
  //}

  if (energy && name) {
    const newIso: IsotopeList = {};
    newIso[energy] = name;

    if (prevIso !== newIso) prevIso = newIso;

    plot.toggleLine(energy, name);
  }
  plot.updatePlot(spectrumData);
}


function plotIsotope(checkbox: HTMLInputElement): void {
  const wordArray = checkbox.id.split('-');
  plot.toggleLine(parseFloat(checkbox.value), wordArray[0] + '-' + wordArray[1], checkbox.checked);
  plot.updatePlot(spectrumData);
}


document.getElementById('check-all-isos')!.onclick = (event) => selectAll(<HTMLInputElement>event.target);

function selectAll(selectBox: HTMLInputElement): void {
  const tableRows = (<HTMLTableElement>document.getElementById('table')).tBodies[0].rows; 

  for (const row of tableRows) {
    const checkBox = <HTMLInputElement>row.cells[0].firstChild;
    checkBox.checked = selectBox.checked;
    if (selectBox.checked) {
      const wordArray = checkBox.id.split('-');
      plot.toggleLine(parseFloat(checkBox.value), wordArray[0] + '-' + wordArray[1], checkBox.checked);
    }
  }
  if (!selectBox.checked) plot.clearAnnos();

  // Bad performance because of Plotly with too many lines!
  plot.updatePlot(spectrumData);
}


document.getElementById('peak-finder-btn')!.onclick = event => findPeaks(<HTMLButtonElement>event.target);

async function findPeaks(button: HTMLButtonElement): Promise<void> {
  if (plot.peakConfig.enabled) {
    switch(plot.peakConfig.mode) {
      case 'gaussian': // Second Mode: Energy
        plot.peakConfig.mode = 'energy';
        button.innerText = 'Energy';
        break;
        
      case 'energy': // Third Mode: Isotopes
        plot.clearPeakFinder(); // Delete all old lines
        await loadIsotopes();
        plot.peakConfig.mode = 'isotopes';
        button.innerText = 'Isotopes';
        break;

      case 'isotopes':
        plot.clearPeakFinder(); // Delete all old lines
        plot.peakConfig.enabled = false;
        button.innerText = 'None';
        break;
    }
  } else { // First Mode: Gauss
    plot.peakConfig.enabled = true;
    plot.peakConfig.mode = 'gaussian';
    button.innerText = 'Gaussian';
  }

  plot.updatePlot(spectrumData);
}

/*
=========================================
  LOADING AND SAVING
=========================================
*/
// These functions are REALLY ugly and a nightmare to maintain, but I don't know how to make it
// better without nuking everything related to the settings and starting again from the ground up.

function saveJSON(name: string, value: string | boolean | number): boolean {
  if (localStorageAvailable) {
    localStorage.setItem(name, JSON.stringify(value));
    return true;
  }
  return false;
}


function loadJSON(name: string): any {
  return JSON.parse(<string>localStorage.getItem(name));
}


function bindInputs(): void {
  const nonSettingsEnterPressElements = {
    'smaVal': 'sma',
    'ser-command': 'send-command'
  }
  for (const [inputId, buttonId] of Object.entries(nonSettingsEnterPressElements)) {
    document.getElementById(inputId)!.onkeydown = event => {
      if (event.key === 'Enter') document.getElementById(buttonId)?.click(); // ENTER key
    };
  }

  // Bind settings button onclick events and enter press, format: {settingsValueElement: settingsName}
  const settingsEnterPressElements = {
    'iso-hover-prox': 'maxIsoDist',
    'custom-url': 'customURL',
    'custom-delimiter': 'fileDelimiter',
    'custom-file-adc': 'fileChannels',
    'custom-baud': 'baudRate',
    'eol-char': 'eolChar',
    'ser-limit': 'timeLimit',
    'custom-ser-refresh': 'plotRefreshRate',
    'custom-ser-buffer': 'serBufferSize',
    'custom-ser-adc': 'serChannels',
    'peak-thres': 'peakThres',
    'peak-lag': 'peakLag',
    'peak-width': 'peakWidth',
    'seek-width': 'seekWidth',
    'gauss-sigma': 'gaussSigma'
  }
  for (const [inputId, settingsName] of Object.entries(settingsEnterPressElements)) {
    const valueElement = <HTMLInputElement>document.getElementById(inputId);
    const buttonElement = <HTMLButtonElement>document.getElementById(`${inputId}-btn`);
    valueElement.onkeydown = event => {
      if (event.key === 'Enter') buttonElement.click(); // Press ENTER key;
    };
    buttonElement.onclick = () => changeSettings(settingsName, valueElement);
  }

  // Bind settings button press or onchange events for settings that do not have the default value input element
  document.getElementById('edit-plot')!.onclick = event => changeSettings('editMode', <HTMLInputElement>event.target); // Checkbox
  document.getElementById('toggle-time-limit')!.onclick = event => changeSettings('timeLimitBool', <HTMLInputElement>event.target); // Checkbox
  document.getElementById('download-format')!.onchange = event => changeSettings('plotDownload', <HTMLSelectElement>event.target); // Select
}


function loadSettingsDefault(): void {
  (<HTMLInputElement>document.getElementById('custom-url')).value = isoListURL;
  (<HTMLInputElement>document.getElementById('edit-plot')).checked = plot.editableMode;
  (<HTMLInputElement>document.getElementById('custom-delimiter')).value = raw.delimiter;
  (<HTMLInputElement>document.getElementById('custom-file-adc')).value = raw.adcChannels.toString();
  (<HTMLInputElement>document.getElementById('custom-ser-refresh')).value = (refreshRate / 1000).toString(); // convert ms to s
  (<HTMLInputElement>document.getElementById('custom-ser-buffer')).value = SerialManager.maxSize.toString();
  (<HTMLInputElement>document.getElementById('custom-ser-adc')).value = SerialManager.adcChannels.toString();
  (<HTMLInputElement>document.getElementById('ser-limit')).value = (maxRecTime / 1000).toString(); // convert ms to s
  (<HTMLInputElement>document.getElementById('toggle-time-limit')).checked = maxRecTimeEnabled;
  (<HTMLInputElement>document.getElementById('iso-hover-prox')).value = maxDist.toString();
  (<HTMLInputElement>document.getElementById('custom-baud')).value = SerialManager.baudRate.toString();
  (<HTMLInputElement>document.getElementById('eol-char')).value = SerialManager.eolChar;

  (<HTMLInputElement>document.getElementById('smaVal')).value = plot.smaLength.toString();

  (<HTMLInputElement>document.getElementById('peak-thres')).value = plot.peakConfig.thres.toString();
  (<HTMLInputElement>document.getElementById('peak-lag')).value = plot.peakConfig.lag.toString();
  (<HTMLInputElement>document.getElementById('peak-width')).value = plot.peakConfig.width.toString();
  (<HTMLInputElement>document.getElementById('seek-width')).value = plot.peakConfig.seekWidth.toString();
  (<HTMLInputElement>document.getElementById('gauss-sigma')).value = plot.gaussSigma.toString();

  const formatSelector = <HTMLSelectElement>document.getElementById('download-format');
  const len = formatSelector.options.length;
  const format = plot.downloadFormat;
  for (let i = 0; i < len; i++) {
    if (formatSelector.options[i].value === format) formatSelector.selectedIndex = i;
  }
}


function loadSettingsStorage(): void {
  let setting = loadJSON('customURL');
  if (setting) isoListURL = new URL(setting).href;

  setting = loadJSON('editMode');
  if (setting) plot.editableMode = setting;

  setting = loadJSON('fileDelimiter');
  if (setting) raw.delimiter = setting;

  setting = loadJSON('fileChannels');
  if (setting) raw.adcChannels = setting;

  setting = loadJSON('plotRefreshRate');
  if (setting) refreshRate = setting;

  setting = loadJSON('serBufferSize');
  if (setting) SerialManager.maxSize = setting;

  setting = loadJSON('timeLimitBool');
  if (setting) maxRecTimeEnabled = setting;

  setting = loadJSON('timeLimit');
  if (setting) maxRecTime = setting;

  setting = loadJSON('maxIsoDist');
  if (setting) maxDist = setting;

  setting = loadJSON('baudRate');
  if (setting) SerialManager.baudRate = setting;

  setting = loadJSON('eolChar');
  if (setting) SerialManager.eolChar = setting;

  setting = loadJSON('serChannels');
  if (setting) SerialManager.adcChannels = setting;

  setting = loadJSON('smaLength');
  if (setting) plot.smaLength = setting;

  setting = loadJSON('peakThres');
  if (setting) plot.peakConfig.thres = setting;

  setting = loadJSON('peakLag');
  if (setting) plot.peakConfig.lag = setting;

  setting = loadJSON('peakWidth');
  if (setting) plot.peakConfig.width = setting;

  setting = loadJSON('seekWidth');
  if (setting) plot.peakConfig.seekWidth = setting;

  setting = loadJSON('plotDownload');
  if (setting) plot.downloadFormat = setting;

  setting = loadJSON('gaussSigma');
  if (setting) plot.gaussSigma = setting;
}


function changeSettings(name: string, element: HTMLInputElement | HTMLSelectElement): void {
  const stringValue = element.value.trim();
  let result = false;

  if (!element.checkValidity() || !stringValue) {
    new Notification('settingType'); //popupNotification('setting-type');
    return;
  }

  switch (name) {
    case 'editMode': {
      const boolVal = (<HTMLInputElement>element).checked;
      plot.editableMode = boolVal;
      plot.resetPlot(spectrumData); // Modify won't be disabled if you don't fully reset
      bindPlotEvents();

      result = saveJSON(name, boolVal);
      break;
    }
    case 'customURL': {
      try {
        isoListURL = new URL(stringValue).href;

        loadIsotopes(true);

        result = saveJSON(name, isoListURL);

      } catch(e) {
        new Notification('settingError'); //popupNotification('setting-error');
        console.error('Custom URL Error', e);
      }
      break;
    }
    case 'fileDelimiter': {
      raw.delimiter = stringValue;

      result = saveJSON(name, stringValue);
      break;
    }
    case 'fileChannels': {
      const numVal = parseInt(stringValue);
      raw.adcChannels = numVal;

      result = saveJSON(name, numVal);
      break;
    }
    case 'timeLimitBool': {
      const boolVal = (<HTMLInputElement>element).checked;
      maxRecTimeEnabled = boolVal;

      result = saveJSON(name, boolVal);
      break;
    }
    case 'timeLimit': {
      const numVal = parseFloat(stringValue);
      maxRecTime = numVal * 1000; // convert s to ms

      result = saveJSON(name, maxRecTime);
      break;
    }
    case 'maxIsoDist': {
      const numVal = parseFloat(stringValue);
      maxDist = numVal;

      result = saveJSON(name, maxDist);
      break;
    }
    case 'plotRefreshRate': {
      const numVal = parseFloat(stringValue);
      refreshRate = numVal * 1000; // convert s to ms

      result = saveJSON(name, refreshRate);
      break;
    }
    case 'serBufferSize': {
      const numVal = parseInt(stringValue);
      SerialManager.maxSize = numVal;

      result = saveJSON(name, SerialManager.maxSize);
      break;
    }
    case 'baudRate': {
      const numVal = parseInt(stringValue);
      SerialManager.baudRate = numVal;

      result = saveJSON(name, SerialManager.baudRate);
      break;
    }
    case 'eolChar': {
      SerialManager.eolChar = stringValue;

      result = saveJSON(name, stringValue);
      break;
    }
    case 'serChannels': {
      const numVal = parseInt(stringValue);
      SerialManager.adcChannels = numVal;

      result = saveJSON(name, numVal);
      break;
    }
    case 'peakThres': {
      const numVal = parseFloat(stringValue);
      plot.peakConfig.thres = numVal;
      plot.updatePlot(spectrumData);

      result = saveJSON(name, numVal);
      break;
    }
    case 'peakLag': {
      const numVal = parseInt(stringValue);
      plot.peakConfig.lag = numVal;
      plot.updatePlot(spectrumData);

      result = saveJSON(name, numVal);
      break;
    }
    case 'peakWidth': {
      const numVal = parseInt(stringValue);
      plot.peakConfig.width = numVal;
      plot.updatePlot(spectrumData);

      result = saveJSON(name, numVal);
      break;
    }
    case 'seekWidth': {
      const numVal = parseFloat(stringValue);
      plot.peakConfig.seekWidth = numVal;
      plot.updatePlot(spectrumData);

      result = saveJSON(name, numVal);
      break;
    }
    case 'plotDownload': {
      plot.downloadFormat = stringValue;
      plot.updatePlot(spectrumData);

      result = saveJSON(name, stringValue);
      break;
    }
    case 'gaussSigma': {
      const numVal = parseInt(stringValue);
      plot.gaussSigma = numVal;
      plot.updatePlot(spectrumData);

      result = saveJSON(name, numVal);
      break;
    }
    default: {
      new Notification('settingError'); //popupNotification('setting-error');
      return;
    }
  }

  if (result) new Notification('settingSuccess'); //popupNotification('setting-success'); // Success Toast
}


document.getElementById('reset-gamma-mca')!.onclick = () => resetMCA();

function resetMCA(): void {
  // Maybe also reset service worker?
  if (localStorageAvailable) localStorage.clear();
  window.location.reload();
}

/*
=========================================
  SERIAL DATA
=========================================
*/

let serRecorder: SerialManager | undefined;


document.getElementById('s1')!.onchange = event => selectSerialType(<HTMLInputElement>event.target);
document.getElementById('s2')!.onchange = event => selectSerialType(<HTMLInputElement>event.target);

function selectSerialType(button: HTMLInputElement): void {
  SerialManager.orderType = <DataOrder>button.value;
  saveJSON('serialDataMode', button.id);
}


function serialConnect(/*event: Event*/): void {
  listSerial();
  new Notification('serialConnect'); //popupNotification('serial-connect');
}


function serialDisconnect(event: Event): void {
  if (serRecorder?.isThisPort(<SerialPort | WebUSBSerialPort>event.target)) disconnectPort(true);

  listSerial();

  new Notification('serialDisconnect'); //popupNotification('serial-disconnect');
}


document.getElementById('serial-list-btn')!.onclick = () => listSerial();

async function listSerial(): Promise<void> {
  const portSelector = <HTMLSelectElement>document.getElementById('port-selector');
  const optionsLen = portSelector.options.length;
  for (let i = optionsLen; i >= 0; i--) { // Remove all "old" ports
    portSelector.remove(i);
  }
  portsAvail = [];
  

  if (navigator.serial) {
    const ports = await navigator.serial.getPorts();
    for (const port of ports) { // List new Ports
      portsAvail.push(new WebSerial(port));
    }
  } else { // Fallback Web USB API, only if Web Serial is not avail
    if (navigator.usb) {
      const ports = await navigator.usb.getDevices();
      for (const port of ports) { // List new Ports
        portsAvail.push(new WebUSBSerial(port));
      }
    }
  }

  let selectIndex = 0;

  for (const index in portsAvail) {
    const option = document.createElement('option');
    option.text = `Port ${index} (${portsAvail[index]?.getInfo()})`;
    portSelector.add(option, parseInt(index));

    if (serRecorder?.isThisPort(portsAvail[index]?.getPort())) {
      selectIndex = parseInt(index);
      option.text = '> ' + option.text;
    }
  }

  const serSettingsElements = document.getElementsByClassName('ser-settings') as HTMLCollectionOf<HTMLInputElement> | HTMLCollectionOf<HTMLSelectElement>;

  if (!portSelector.options.length) {
    const option = document.createElement('option');
    option.text = 'No Ports Available';
    portSelector.add(option);

    for (const element of serSettingsElements) {
      element.disabled = true;
    }
  } else {
    portSelector.selectedIndex = selectIndex;
    
    for (const element of serSettingsElements) {
      element.disabled = false;
    }
  }
}


document.getElementById('serial-add-device')!.onclick = () => requestSerial();

async function requestSerial(): Promise<void> {
  try {
    if (navigator.serial) {
      await navigator.serial.requestPort();
    } else {
      await navigator.usb.requestDevice({
        filters : WebUSBSerial.deviceFilters 
			});
    }
    listSerial();
  } catch(err) {
    console.warn('Aborted adding a new port!', err); // Do nothing.
  }
}


function selectPort(): number {
  const selectedPort = (<HTMLSelectElement>document.getElementById('port-selector')).selectedIndex;
  const newport = portsAvail[selectedPort];

  if (newport && !serRecorder?.isThisPort(newport.getPort())) { // serRecorder?.port != newport
    serRecorder = new SerialManager(newport);
    clearConsoleLog(); // Clear serial console history
  }

  return selectedPort;
}


document.getElementById('resume-button')!.onclick = () => startRecord(true, recordingType);
document.getElementById('record-spectrum-btn')!.onclick = () => startRecord(false, 'data');
document.getElementById('record-bg-btn')!.onclick = () => startRecord(false, 'background');

let recordingType: DataType;
let startDate: Date;
let endDate: Date;

async function startRecord(pause = false, type: DataType): Promise<void> {
  try {
    selectPort();
    await serRecorder?.startRecord(pause);
  } catch(err) {
    console.error('Connection Error:', err);
    new Notification('serialConnectError'); //popupNotification('serial-connect-error');
    return;
  }

  recordingType = type;

  if (!pause) {
    removeFile(type); // Remove old spectrum
    startDate = new Date();
  }

  (<HTMLButtonElement>document.getElementById('stop-button')).disabled = false;
  document.getElementById('pause-button')!.classList.remove('d-none');
  document.getElementById('record-button')!.classList.add('d-none');
  document.getElementById('resume-button')!.classList.add('d-none');

  const spinnerElements = document.getElementsByClassName('recording-spinner');

  for (const ele of spinnerElements) {
    ele.classList.remove('d-none');
  }

  refreshRender(type, !pause); // Start updating the plot
  refreshMeta(type); // Start updating the meta data

  // Check if pause ? Last cps value after pausing is always 0, remove! : Empty if just started to record
  pause ? cpsValues.pop() : cpsValues = [];

  //plot.updatePlot(spectrumData); // Prevent the plot from moving all over the screen due to other things popping-up
}


document.getElementById('pause-button')!.onclick = () => disconnectPort();
document.getElementById('stop-button')!.onclick = () => disconnectPort(true);

async function disconnectPort(stop = false): Promise<void> {
  document.getElementById('pause-button')!.classList.add('d-none');
  const spinnerElements = document.getElementsByClassName('recording-spinner');

  for (const ele of spinnerElements) {
    ele.classList.add('d-none');
  }

  document.getElementById('resume-button')!.classList.toggle('d-none', stop);

  if (stop) {
    (<HTMLButtonElement>document.getElementById('stop-button')).disabled = true;
    document.getElementById('record-button')!.classList.remove('d-none');

    endDate = new Date();
  }

  try {
    clearTimeout(refreshTimeout);
    clearTimeout(metaTimeout);
    clearTimeout(consoleTimeout);
  } catch (err) {
    console.warn('No timeout to clear. Something might be wrong...', err);
  }

  try {
    await serRecorder?.stopRecord();
  } catch(error) {
    // Sudden device disconnect can cause this
    console.error('Misc Serial Read Error:', error);
    new Notification('miscSerialError'); //popupNotification('misc-ser-error');
  }
}


document.getElementById('clear-console-log')!.onclick = () => clearConsoleLog();

function clearConsoleLog(): void {
  document.getElementById('ser-output')!.innerText = '';
  serRecorder?.flushRawData();
}


document.getElementById('serialConsoleModal')!.addEventListener('show.bs.modal', (/*event: Event*/): void => { // Adjust Plot Size For Main Tab Menu Content Size
  readSerial();
});

document.getElementById('serialConsoleModal')!.addEventListener('hide.bs.modal', async (/*event: Event*/): Promise<void> => { // Adjust Plot Size For Main Tab Menu Content Size
  await serRecorder?.hideConsole();
  clearTimeout(consoleTimeout);
});


async function readSerial(): Promise<void> {
  try {
    const portNumber = selectPort();
    document.getElementById('serial-console-title')!.innerText = `Serial Console (Port ${portNumber})`;
    await serRecorder?.showConsole();
  } catch(err) {
    console.error('Connection Error:', err);
    new Notification('serialConnectError'); //popupNotification('serial-connect-error');
    return;
  }

  refreshConsole();
}


document.getElementById('send-command')!.onclick = () => sendSerial();

async function sendSerial(): Promise<void> {
  const element = <HTMLInputElement>document.getElementById('ser-command');
  try {
    await serRecorder?.sendString(element.value);
  } catch (err) {
    console.error('Connection Error:', err);
    new Notification('serialConnectError'); //popupNotification('serial-connect-error');
    return;
  }

  element.value = '';
}


document.getElementById('reconnect-console-log')!.onclick = () => reconnectConsole();

async function reconnectConsole(): Promise<void> {
  await serRecorder?.hideConsole(); // Same code as closing and re-opening of the console modal
  clearTimeout(consoleTimeout);
  readSerial();
}


let autoscrollEnabled = false;

document.getElementById('autoscroll-console')!.onclick = event => toggleAutoscroll((<HTMLInputElement>event.target).checked);

function toggleAutoscroll(enabled: boolean) {
  autoscrollEnabled = enabled;
  saveJSON('consoleAutoscrollEnabled', autoscrollEnabled);
}


let consoleTimeout: number;

function refreshConsole(): void {
  if (serRecorder?.port?.isOpen) {
    document.getElementById('ser-output')!.innerText = serRecorder.getRawData();
    consoleTimeout = setTimeout(refreshConsole, CONSOLE_REFRESH);

    if (autoscrollEnabled) document.getElementById('ser-output')!.scrollIntoView({behavior: 'smooth', block: 'end'});
  }
}


function getRecordTimeStamp(time: number): string {
  const dateTime = new Date(time);
  return addLeadingZero(dateTime.getUTCHours().toString()) + ':' + addLeadingZero(dateTime.getUTCMinutes().toString()) + ':' + addLeadingZero(dateTime.getUTCSeconds().toString());
}


let metaTimeout: number;

function refreshMeta(type: DataType): void {
  if (serRecorder?.port?.isOpen) {
    const nowTime = performance.now();

    const totalTimeElement = document.getElementById('total-record-time')!;

    const totalMeasTime = serRecorder.getTime();

    spectrumData[`${type}Time`] = totalMeasTime; // Update measurementTime in spectrum data
    
    document.getElementById('record-time')!.innerText = getRecordTimeStamp(totalMeasTime);
    const delta = new Date(totalMeasTime);

    if (maxRecTimeEnabled) {
      const progressElement = document.getElementById('ser-time-progress')!;
      const progress = Math.round(delta.getTime() / maxRecTime * 100);
      progressElement.style.width = progress + '%';
      progressElement.innerText = progress + '%';
      progressElement.setAttribute('aria-valuenow', progress.toString())

      totalTimeElement.innerText = ' / ' +  getRecordTimeStamp(maxRecTime);
    } else {
      totalTimeElement.innerText = '';
    }
    document.getElementById('ser-time-progress-bar')!.classList.toggle('d-none', !maxRecTimeEnabled);

    updateSpectrumTime();

    if (delta.getTime() >= maxRecTime && maxRecTimeEnabled) {
      disconnectPort(true);
      new Notification('autoStop'); //popupNotification('auto-stop');
    } else {
      const finishDelta = performance.now() - nowTime;
      metaTimeout = setTimeout(refreshMeta, (REFRESH_META_TIME - finishDelta > 0) ? (REFRESH_META_TIME - finishDelta) : 1, type); // Only re-schedule if still available
    }
  }
}


let lastUpdate = performance.now();
let refreshTimeout: number;

function refreshRender(type: DataType, firstLoad = false): void {
  if (serRecorder?.port?.isOpen) {
    const startDelay = performance.now();

    //await serRecorder.stopRecord(); // Maybe?!
    const newData = serRecorder.getData(); // Get all the new data
    const measTime = serRecorder.getTime() ?? 1000;
    //await serRecorder.startRecord(true); // Maybe?!

    if (SerialManager.orderType === 'hist') {
      spectrumData.addHist(type, newData);
    } else if (SerialManager.orderType === 'chron') {
      spectrumData.addPulseData(type, newData, SerialManager.adcChannels);
    }

    spectrumData[`${type}Cps`] = spectrumData[type].map(val => val / measTime * 1000);

    if (firstLoad) {
      plot.resetPlot(spectrumData); // Prevent the overlay going into the toolbar
      bindPlotEvents();
    } else {
      plot.updatePlot(spectrumData);
    }

    const deltaLastRefresh = measTime - lastUpdate;
    lastUpdate = measTime;

    const cpsValue = ((SerialManager.orderType === 'chron') ? newData.length : newData.reduce((acc, curr) => acc+curr, 0)) / deltaLastRefresh * 1000;
    cpsValues.push(cpsValue);

    document.getElementById('cps')!.innerText = cpsValue.toFixed(1) + ' cps';

    const mean = cpsValues.reduce((acc, curr) => acc+curr, 0) / cpsValues.length;
    const std = Math.sqrt(cpsValues.reduce((acc, curr) => acc + (curr - mean)**2, 0) / (cpsValues.length - 1));

    document.getElementById('avg-cps')!.innerHTML = 'Avg: ' + mean.toFixed(1);
    document.getElementById('avg-cps-std')!.innerHTML = ` &plusmn; ${std.toFixed(1)} cps (&#916; ${Math.round(std/mean*100)}%)`;

    updateSpectrumCounts();

    const finishDelta = performance.now() - startDelay;
    refreshTimeout = setTimeout(refreshRender, (refreshRate - finishDelta > 0) ? (refreshRate - finishDelta) : 1, type);
  }
}
