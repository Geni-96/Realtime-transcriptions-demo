describe('serviceWorker tab capture handler', () => {
  let messageHandler;
  let captureOptions;
  let connectMock;
  let audioContextInstance;

  beforeEach(() => {
    jest.resetModules();
    captureOptions = { audio: true, video: false };
    connectMock = jest.fn();
    audioContextInstance = {
      createMediaStreamSource: jest.fn(() => ({ connect: connectMock })),
      destination: { id: 'destination-node' }
    };

    const listeners = {
      onMessage: null
    };

    global.AudioContext = jest.fn(() => audioContextInstance);

    global.chrome = {
      runtime: {
        onInstalled: { addListener: jest.fn() },
        onMessage: {
          addListener: jest.fn((cb) => {
            listeners.onMessage = cb;
          })
        },
        lastError: null
      },
      tabs: {
        onUpdated: {
          addListener: jest.fn()
        }
      },
      sidePanel: {
        setOptions: jest.fn(() => Promise.resolve())
      },
      tabCapture: {
        capture: jest.fn()
      }
    };

    require('../src/background/serviceWorker.js');
    messageHandler = listeners.onMessage;
    if (typeof messageHandler !== 'function') {
      throw new Error('runtime.onMessage listener was not registered');
    }
  });

  afterEach(() => {
    delete global.chrome;
    delete global.AudioContext;
  });

  it('responds with success when tab capture returns a stream', async () => {
    const dummyStream = { id: 'stream-1' };

    chrome.tabCapture.capture.mockImplementation((options, callback) => {
      expect(options).toEqual(captureOptions);
      callback(dummyStream);
    });

    chrome.runtime.lastError = null;
    const sendResponse = jest.fn();
    const returned = messageHandler({ action: 'startTranscription' }, {}, sendResponse);

    expect(returned).toBe(true);

    await new Promise(setImmediate);

    expect(sendResponse).toHaveBeenCalledWith({ status: 'Transcription started' });
    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(audioContextInstance.createMediaStreamSource).toHaveBeenCalledWith(dummyStream);
    expect(connectMock).toHaveBeenCalledWith(audioContextInstance.destination);
  });

  it('responds with an error when tab capture fails to provide a stream', async () => {
    const runtimeError = { message: 'capture failed' };

    chrome.tabCapture.capture.mockImplementation((options, callback) => {
      expect(options).toEqual(captureOptions);
      chrome.runtime.lastError = runtimeError;
      callback(null);
    });

    const sendResponse = jest.fn();
    const returned = messageHandler({ action: 'startTranscription' }, {}, sendResponse);

    expect(returned).toBe(true);

    await new Promise(setImmediate);

    expect(sendResponse).toHaveBeenCalledWith({
      status: 'Error starting transcription',
      error: runtimeError
    });
    expect(AudioContext).not.toHaveBeenCalled();
  });

  it('catches synchronous errors from tabCapture and responds with failure', async () => {
    const syncError = new Error('unexpected');

    chrome.tabCapture.capture.mockImplementation(() => {
      throw syncError;
    });

    const sendResponse = jest.fn();
    const returned = messageHandler({ action: 'startTranscription' }, {}, sendResponse);

    expect(returned).toBe(true);

    await new Promise(setImmediate);

    expect(sendResponse).toHaveBeenCalledWith({
      status: 'Error starting transcription',
      error: syncError
    });
  });
});
