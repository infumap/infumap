/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { base64ArrayBuffer } from "./base64ArrayBuffer";

// Image item placeholders (the "thumbnail" field) are created by the server: see create_image_placeholder in
// infumap/src/util/image.rs. They are one of:
//   - legacy: a base64 encoded 8x8 PNG.
//   - version 1: base64 encoded [1][width][height][JPEG entropy-coded data]. The JPEG header is the same for all
//     version 1 placeholders except for the dimensions, so is not stored, and is reconstructed here.

const LEGACY_PNG_BASE64_PREFIX = "iVBORw0KGgo";

// JPEG header (SOI up to and including SOS) of version 1 placeholders, with the SOF0 width and height set to 0.
// The server tests (placeholder_header_matches_client_template) check this matches the server encoder output.
const PLACEHOLDER_V1_JPEG_HEADER_BASE64 = "/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAAAAAADAREAAhEBAxEB/9sAQwAbEhQXFBEbFxYXHhwbIChCKyglJShROj0wQmBVZWRfVV1baniZgWpxkHNbXYW1hpCeo6utq2eAvMm6pseZqKuk/9sAQwEcHh4oIyhOKytOpG5dbqSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSk/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwA=";

let placeholderV1HeaderMaybe: Uint8Array | null = null;
let placeholderV1Sof0Offset = -1;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; ++i) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
}

function placeholderV1Header(): Uint8Array {
  if (placeholderV1HeaderMaybe == null) {
    placeholderV1HeaderMaybe = base64ToBytes(PLACEHOLDER_V1_JPEG_HEADER_BASE64);
    for (let i = 0; i < placeholderV1HeaderMaybe.length - 1; ++i) {
      if (placeholderV1HeaderMaybe[i] == 0xFF && placeholderV1HeaderMaybe[i + 1] == 0xC0) {
        placeholderV1Sof0Offset = i;
        break;
      }
    }
  }
  return placeholderV1HeaderMaybe;
}

/**
 * Convert the thumbnail field of an image item to a url that can be used as an img src.
 */
export function imagePlaceholderSrc(thumbnail: string): string {
  if (thumbnail == "" || thumbnail.startsWith(LEGACY_PNG_BASE64_PREFIX)) {
    return "data:image/png;base64, " + thumbnail;
  }

  let placeholder: Uint8Array;
  try {
    placeholder = base64ToBytes(thumbnail);
  } catch (e) {
    console.warn("Could not decode image placeholder:", e);
    return "";
  }
  if (placeholder.length < 3 || placeholder[0] != 1) {
    console.warn(`Unsupported image placeholder version: ${placeholder[0]}.`);
    return "";
  }

  const header = placeholderV1Header();
  const width = placeholder[1];
  const height = placeholder[2];
  const jpeg = new Uint8Array(header.length + placeholder.length - 3 + 2);
  jpeg.set(header, 0);
  jpeg[placeholderV1Sof0Offset + 5] = height >> 8;
  jpeg[placeholderV1Sof0Offset + 6] = height & 0xFF;
  jpeg[placeholderV1Sof0Offset + 7] = width >> 8;
  jpeg[placeholderV1Sof0Offset + 8] = width & 0xFF;
  jpeg.set(placeholder.subarray(3), header.length);
  jpeg[jpeg.length - 2] = 0xFF; // EOI
  jpeg[jpeg.length - 1] = 0xD9;
  return "data:image/jpeg;base64," + base64ArrayBuffer(jpeg.buffer);
}
