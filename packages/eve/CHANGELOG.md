# @archildata/eve

## 0.0.24

### Patch Changes

- Updated dependencies [20dc96c]
  - disk@1.12.1

## 0.0.23

### Patch Changes

- 036417b: `disk` now depends only on `@archildata/api-types` and `undici`. It no longer installs `uuid`, `openapi-fetch`, `fast-xml-parser`, `commander`, or `@clack/prompts`: the control-plane client, S3 XML parsing, and the `disk`/`sandbox` command-line parsing, spinner, and API-key prompt are built in. `zod` is now an optional peer dependency used only by `disk/internal/tools`, so installing `disk` no longer pulls it in; `@archildata/eve` now depends on `zod` directly. `undici` is updated to 8.12.3 and no longer pinned to an exact version (`^8.12.3`), and `@archildata/api-types` to 0.0.79. S3 listings now keep leading and trailing spaces in object keys (they were trimmed) and decode numeric character references such as `&#233;`.
- Updated dependencies [340d4bb]
- Updated dependencies [036417b]
- Updated dependencies [e282728]
- Updated dependencies [4516a02]
- Updated dependencies [e491563]
  - disk@1.12.0

## 0.0.22

### Patch Changes

- Updated dependencies [2135fc1]
  - disk@1.11.0

## 0.0.21

### Patch Changes

- Updated dependencies [d44913a]
  - disk@1.10.0

## 0.0.20

### Patch Changes

- Updated dependencies [edcccb7]
  - disk@1.9.0

## 0.0.19

### Patch Changes

- Updated dependencies [8b2000c]
  - disk@1.8.0

## 0.0.18

### Patch Changes

- Updated dependencies [df67b51]
- Updated dependencies [ca2e89e]
- Updated dependencies [5326863]
  - disk@1.7.0

## 0.0.17

### Patch Changes

- Updated dependencies [1ecc788]
  - disk@1.6.0

## 0.0.16

### Patch Changes

- Updated dependencies [76f5d06]
  - disk@1.5.0

## 0.0.15

### Patch Changes

- Updated dependencies [0bbf053]
  - disk@1.4.0

## 0.0.14

### Patch Changes

- Updated dependencies [019334e]
- Updated dependencies [6929bbe]
  - disk@1.3.0

## 0.0.13

### Patch Changes

- Updated dependencies [c48da00]
- Updated dependencies [68620ac]
- Updated dependencies [a525194]
  - disk@1.2.0

## 0.0.12

### Patch Changes

- Updated dependencies [3a8b100]
  - disk@1.1.2

## 0.0.11

### Patch Changes

- Updated dependencies [763c659]
- Updated dependencies [dc930d0]
- Updated dependencies [aa5728c]
  - disk@1.1.1

## 0.0.10

### Patch Changes

- Updated dependencies [eda614b]
  - disk@1.1.0

## 0.0.9

### Patch Changes

- Updated dependencies [3a499ac]
- Updated dependencies [c42a823]
  - disk@1.0.0

## 0.0.8

### Patch Changes

- Updated dependencies [ae19201]
- Updated dependencies [36be5e2]
  - disk@0.11.0

## 0.0.7

### Patch Changes

- Updated dependencies [1548884]
  - disk@0.10.0

## 0.0.6

### Patch Changes

- Updated dependencies [9aa3141]
- Updated dependencies [bb2e683]
- Updated dependencies [b9610a3]
- Updated dependencies [b9610a3]
  - disk@0.9.0

## 0.0.5

### Patch Changes

- Updated dependencies [45df6fe]
  - disk@0.8.23

## 0.0.4

### Patch Changes

- Updated dependencies [6250abe]
  - disk@0.8.22

## 0.0.3

### Patch Changes

- Updated dependencies [7d1d144]
  - disk@0.8.21

## 0.0.2

### Patch Changes

- Updated dependencies [a60afde]
  - disk@0.8.20

## 0.0.1

### Patch Changes

- Updated dependencies [da5ab50]
  - disk@0.8.19
