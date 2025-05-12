const chunkGenerator = async function* (
  reader: ReadableStreamDefaultReader<Uint8Array>,
) {
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    yield value;
  }
};

export async function* processLines(
  response: Response,
): AsyncGenerator<string[], void, unknown> {
  if (!response.body) {
    throw new Error("No body in response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let partialLine = "";
  for await (const chuck of chunkGenerator(reader)) {
    const text = partialLine + decoder.decode(chuck);
    const lines = text.split("\n");
    partialLine = lines.pop() || "";
    yield lines;
  }
  if (partialLine) {
    yield [partialLine];
  }
  reader.releaseLock();
}
