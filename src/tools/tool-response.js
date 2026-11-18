function jsonToolResponse(data, metadata) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ...data, metadata }, null, 2),
      },
    ],
  };
}
function formattedToolResponse(data, metadata, format, markdown) {
  if (format === 'markdown') {
    return {
      content: [
        {
          type: 'text',
          text: `${markdown.trim()}

---

metadata: ${JSON.stringify(metadata)}`,
        },
      ],
    };
  }
  return jsonToolResponse(data, metadata);
}
function errorToolResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
export { errorToolResponse, formattedToolResponse, jsonToolResponse };
