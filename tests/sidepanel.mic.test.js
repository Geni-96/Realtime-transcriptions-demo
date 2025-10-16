/** @jest-environment jsdom */

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

function createFakeStream(id) {
  return {
    id,
    getTracks: jest.fn(() => []),
    getAudioTracks: jest.fn(() => [{ id: `${id}-audio` }]),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn()
  };
}

describe('sidepanel microphone capture', () => {
  let originalPlay;
  let originalPause;
  let originalSrcObject;

  beforeAll(() => {
    originalPlay = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'play');
    originalPause = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'pause');
    Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: jest.fn(() => Promise.resolve())
    });
    Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: jest.fn()
    });
    originalSrcObject = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'srcObject');
    Object.defineProperty(window.HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() {
        return this._srcObject || null;
      },
      set(value) {
        this._srcObject = value;
      }
    });
  });

  afterAll(() => {
    if (originalPlay) {
      Object.defineProperty(window.HTMLMediaElement.prototype, 'play', originalPlay);
    }
    if (originalPause) {
      Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', originalPause);
    }
    if (originalSrcObject) {
      Object.defineProperty(window.HTMLMediaElement.prototype, 'srcObject', originalSrcObject);
    } else {
      delete window.HTMLMediaElement.prototype.srcObject;
    }
  });

  function setupDom(includeMicChecked = true) {
    document.body.innerHTML = `
      <div>
        <input id="includeMicrophone" type="checkbox" ${includeMicChecked ? 'checked' : ''} />
        <button id="startBtn">Start</button>
        <button id="stopBtn">Stop</button>
        <button id="downloadBtn" disabled>Download</button>
        <div id="status"></div>
        <div id="transcript"></div>
      </div>
    `;
  }

  function setupCommonMocks({ includeMicChecked = true, micStreamPromise }) {
    jest.resetModules();
    setupDom(includeMicChecked);

    const tabStream = createFakeStream('tab-stream');
    const micStream = createFakeStream('mic-stream');
    const destinationStream = createFakeStream('mixed-stream');

    const startButton = document.getElementById('startBtn');
    const includeMic = document.getElementById('includeMicrophone');
    includeMic.checked = includeMicChecked;

    navigator.mediaDevices = {
      getUserMedia: jest.fn(() => micStreamPromise ?? Promise.resolve(micStream))
    };

    const destinationNode = { stream: destinationStream };
    const gainNodes = [];

    const audioContextInstance = {
      resume: jest.fn(() => Promise.resolve()),
      createMediaStreamSource: jest.fn(() => ({
        connect: jest.fn(() => undefined)
      })),
      createGain: jest.fn(() => {
        const node = {
          gain: { value: 0 },
          connect: jest.fn(() => undefined)
        };
        gainNodes.push(node);
        return node;
      }),
      createMediaStreamDestination: jest.fn(() => destinationNode),
      destination: { id: 'mock-destination' }
    };

    window.AudioContext = jest.fn(() => audioContextInstance);
    window.webkitAudioContext = undefined;

    class FakeMediaRecorder {
      constructor(stream, options = {}) {
        this.stream = stream;
        this.state = 'inactive';
        this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
      }
      start() {
        this.state = 'recording';
        if (typeof this.onstart === 'function') this.onstart();
      }
      stop() {
        this.state = 'inactive';
        if (typeof this.onstop === 'function') this.onstop();
      }
    }

    global.MediaRecorder = FakeMediaRecorder;

    const activeTab = { id: 123, url: 'https://example.com/watch?v=1' };

    global.chrome = {
      runtime: {
        lastError: null,
        onInstalled: { addListener: jest.fn() }
      },
      storage: {
        local: { get: jest.fn((keys, cb) => cb({})) }
      },
      tabs: {
        query: jest.fn((queryInfo, cb) => cb([activeTab])),
        update: jest.fn(),
        get: jest.fn((tabId, cb) => cb({ mutedInfo: { muted: false } }))
      },
      tabCapture: {
        capture: jest.fn((options, cb) => cb(tabStream)),
        getMediaStreamId: jest.fn()
      },
      sidePanel: {
        setOptions: jest.fn(() => Promise.resolve())
      }
    };

    const sidepanelHooks = require('../src/sidepanel/sidepanel.js');

    return {
      startButton,
      includeMic,
      statusDiv: document.getElementById('status'),
      chrome: global.chrome,
      navigator,
      sidepanelHooks,
      tabStream,
      micStream,
      audioContextInstance,
      destinationNode,
      destinationStream,
      getMonitorElement: () => document.querySelector('audio'),
      gainNodes
    };
  }

  afterEach(() => {
    delete global.chrome;
    delete global.MediaRecorder;
    delete window.AudioContext;
    delete window.webkitAudioContext;
    delete navigator.mediaDevices;
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  it('requests microphone audio when the option is enabled', async () => {
    const { startButton, sidepanelHooks, navigator, audioContextInstance, micStream, gainNodes, destinationNode, getMonitorElement } = setupCommonMocks({ includeMicChecked: true });

    startButton.click();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }),
      video: false
    }));

    const state = sidepanelHooks.getState();
    expect(state.micStream).toBe(micStream);
    expect(state.tabStream).toBeTruthy();
    expect(audioContextInstance.createMediaStreamSource).toHaveBeenCalledTimes(2);

    expect(gainNodes.length).toBeGreaterThanOrEqual(6);
    const tabMonitorGain = gainNodes[1];
    const micMonitorGain = gainNodes[3];
    expect(tabMonitorGain.gain.value).toBeGreaterThan(0);
    expect(micMonitorGain.gain.value).toBe(0);

    const mixBusNode = gainNodes[4];
    expect(mixBusNode.connect).toHaveBeenCalledWith(destinationNode);
    const monitorBusNode = gainNodes[5];
    expect(monitorBusNode.connect).toHaveBeenCalledWith(audioContextInstance.destination);

    const monitorEl = getMonitorElement();
    expect(monitorEl).not.toBeNull();
    expect(monitorEl.srcObject).toBe(sidepanelHooks.getState().tabStream);
  });

  it('skips microphone capture when the checkbox is unchecked', async () => {
    const { startButton, sidepanelHooks, navigator, getMonitorElement } = setupCommonMocks({ includeMicChecked: false });

    startButton.click();
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const state = sidepanelHooks.getState();
    expect(state.micStream).toBeNull();
    expect(window.AudioContext).not.toHaveBeenCalled();

    const monitorEl = getMonitorElement();
    expect(monitorEl).not.toBeNull();
    expect(monitorEl.srcObject).toBe(state.tabStream);
  });

  it('falls back gracefully when microphone capture fails', async () => {
    const micError = new Error('mic denied');
    const failingPromise = Promise.reject(micError);
  const { startButton, sidepanelHooks, navigator, audioContextInstance, gainNodes, getMonitorElement } = setupCommonMocks({
      includeMicChecked: true,
      micStreamPromise: failingPromise
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Prevent unhandled rejection warnings
      failingPromise.catch(() => {});

      startButton.click();
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

      const state = sidepanelHooks.getState();
      expect(state.micStream).toBeNull();
      expect(audioContextInstance.createMediaStreamSource).toHaveBeenCalledTimes(1);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mic denied'), micError);

      // Only tab gain nodes should be present in this scenario
      expect(gainNodes.length).toBeGreaterThanOrEqual(4);
      const fallbackMonitorGain = gainNodes.find((node) => node.gain.value === 0 && node.connect.mock.calls.length === 0);
      expect(fallbackMonitorGain).toBeUndefined();

      const monitorEl = getMonitorElement();
      expect(monitorEl).not.toBeNull();
      expect(monitorEl.srcObject).toBe(sidepanelHooks.getState().tabStream);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
