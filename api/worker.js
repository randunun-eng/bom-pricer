export default {
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    const { bom } = await req.json();

    // placeholder: later call Python service or Nova
    return Response.json({
      status: "ok",
      message: "BOM received",
      bom
    });
  }
}
