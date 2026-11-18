# Host ABI pixel-diff evidence (NOT device evidence)
platform: build-host software raster
device: N/A (adb not installed; xcrun no available/attached iOS device)
ir: todo.opuir.json (shipped mobile asset)
viewport: 320x240 RGBA8
digest: FNV-1a 64-bit hex over RGBA bytes

| step | ABI event | frame digest | changed pixels vs baseline |
| --- | --- | --- | --- |
| 0 | initial | 2687ffd7c45f45d9 | 0 |
| 1 | set_node_states([10, hover]) | 6e6f4c640923b8fd | 1782 |
| 2 | set_node_states([10, focus]) | 8419927c2a0e1ca8 | - |
| 3 | set_node_states(null, 0) | 2687ffd7c45f45d9 | 0 |
| 4 | set_press(10, 3900, down) | d4f5f41a2b9d231b | 1927 |
| 5 | set_press(10, 4000, confirm) | d4f5f41a2b9d231b | - |
| 6 | set_press(0, 0, clear) | 2687ffd7c45f45d9 | 0 |

replay: all six digests reproduced byte-for-byte on a fresh OpuRenderer.
