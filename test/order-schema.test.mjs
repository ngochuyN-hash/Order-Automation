import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_SEMANTICS, buildGeminiResponseSchema, buildOpenAIJsonSchema } from '../src/order/order-schema.mjs';
import { supportsStructuredOutput, normalizeEndpointUrl, resolveTestUrl, AI_PROVIDERS } from '../ai-providers.mjs';

// Duyệt đệ quy toàn bộ schema, gọi callback(node, path)
function walkSchema(node, fn, path = '$') {
  if (!node || typeof node !== 'object') return;
  fn(node, path);
  for (const [key, val] of Object.entries(node)) {
    if (key === 'properties' && val && typeof val === 'object') {
      for (const [propName, propSchema] of Object.entries(val)) {
        walkSchema(propSchema, fn, `${path}.${propName}`);
      }
    } else if ((key === 'items' || key === 'anyOf') && Array.isArray(val)) {
      val.forEach((sub, i) => walkSchema(sub, fn, `${path}[${i}]`));
    } else if ((key === 'items' || key === 'additionalProperties') && val && typeof val === 'object' && !Array.isArray(val)) {
      walkSchema(val, fn, `${path}.*`);
    }
  }
}

describe('order-schema — ORDER_SEMANTICS', () => {
  it('không rỗng và toàn bộ entry là chuỗi có nội dung', () => {
    assert.ok(Array.isArray(ORDER_SEMANTICS) && ORDER_SEMANTICS.length >= 10);
    for (const s of ORDER_SEMANTICS) {
      assert.equal(typeof s, 'string');
      assert.ok(s.trim().length > 5);
    }
  });

  it('bao phủ đủ các trường chính của output', () => {
    const joined = ORDER_SEMANTICS.join('\n');
    for (const field of ['customer', 'payment', 'notes', 'items[].qty', 'items[].unit', 'items[].rawProduct', 'items[].kvCode', 'items[].explicitPrice', 'items[].priceTierQty', 'items[].isGift', 'items[].explicitGift', 'tln']) {
      assert.ok(joined.includes(field), `thiếu ngữ nghĩa cho ${field}`);
    }
  });
});

describe('order-schema — buildGeminiResponseSchema', () => {
  const schema = buildGeminiResponseSchema();

  it('type UPPERCASE ở mọi node (subset OpenAPI của Gemini)', () => {
    const validTypes = ['OBJECT', 'STRING', 'NUMBER', 'BOOLEAN', 'ARRAY', 'INTEGER'];
    walkSchema(schema, (node) => {
      if ('type' in node) {
        assert.ok(validTypes.includes(node.type), `type "${node.type}" không phải dạng Gemini UPPERCASE`);
        assert.equal(node.type, node.type.toUpperCase());
      }
    });
  });

  it('nullable riêng (không dùng anyOf/type array như OpenAI)', () => {
    for (const f of ['customer', 'payment', 'kvCode', 'explicitPrice', 'priceTierQty', 'explicitGift']) {
      const node = f in schema.properties ? schema.properties[f] : schema.properties.items.items.properties[f];
      assert.equal(node.nullable, true, `${f} phải nullable:true`);
      assert.ok(!('anyOf' in node), `${f} không được dùng anyOf`);
    }
    // Trường bắt buộc luôn có giá trị thì KHÔNG nullable
    for (const f of ['qty', 'unit', 'rawProduct', 'isGift']) {
      assert.ok(!schema.properties.items.items.properties[f].nullable);
    }
  });

  it('required top-level đủ 5 trường, item required đủ 8 trường', () => {
    assert.deepEqual([...schema.required].sort(), ['customer', 'items', 'notes', 'payment', 'tln']);
    assert.deepEqual(
      [...schema.properties.items.items.required].sort(),
      ['explicitGift', 'explicitPrice', 'isGift', 'kvCode', 'priceTierQty', 'qty', 'rawProduct', 'unit']
    );
    assert.deepEqual([...schema.properties.items.items.properties.explicitGift.required].sort(), ['name', 'qty', 'unit']);
  });

  it('required nào cũng phải tồn tại trong properties (Gemini sẽ 400 nếu thiếu)', () => {
    walkSchema(schema, (node, path) => {
      if (Array.isArray(node.required)) {
        assert.ok(node.properties, `required tại ${path} nhưng không có properties`);
        for (const req of node.required) {
          assert.ok(req in node.properties, `required "${req}" tại ${path} không có trong properties`);
        }
      }
    });
  });

  it('payment enum khớp 5 giá trị nghiệp vụ', () => {
    assert.deepEqual([...schema.properties.payment.enum].sort(), ['ck', 'cod', 'congno', 'other', 'tt']);
  });
});

describe('order-schema — buildOpenAIJsonSchema (strict mode)', () => {
  const schema = buildOpenAIJsonSchema();

  it('type lowercase ở mọi node', () => {
    walkSchema(schema, (node) => {
      if ('type' in node) assert.equal(node.type, node.type.toLowerCase());
    });
  });

  it('MỌI property nằm trong required (điều kiện bắt buộc strict mode)', () => {
    walkSchema(schema, (node, path) => {
      if (node.type === 'object') {
        assert.ok(Array.isArray(node.required), `object tại ${path} thiếu required`);
        assert.equal(node.additionalProperties, false, `object tại ${path} thiếu additionalProperties:false`);
        for (const propName of Object.keys(node.properties || {})) {
          assert.ok(node.required.includes(propName), `"${propName}" tại ${path} không nằm trong required → strict mode sẽ từ chối`);
        }
      }
    });
  });

  it('nullable biểu diễn qua anyOf [..., {type:"null"}]', () => {
    const itemProps = schema.properties.items.items.properties;
    for (const f of ['customer', 'kvCode', 'explicitPrice', 'priceTierQty', 'explicitGift']) {
      const node = f in schema.properties ? schema.properties[f] : itemProps[f];
      assert.ok(Array.isArray(node.anyOf), `${f} phải dùng anyOf`);
      assert.ok(node.anyOf.some(s => s.type === 'null'), `${f} thiếu nhánh {type:'null'}`);
    }
  });

  it('payment enum + explicitGift object đầy đủ', () => {
    const giftNode = schema.properties.items.items.properties.explicitGift;
    const objVariant = giftNode.anyOf.find(s => s.type === 'object');
    assert.deepEqual([...objVariant.required].sort(), ['name', 'qty', 'unit']);
    assert.deepEqual([...schema.properties.payment.enum].sort(), ['ck', 'cod', 'congno', 'other', 'tt']);
  });
});

describe('order-schema — tương thích chéo 2 biến thể', () => {
  it('cùng bộ trường & required ở mọi cấp (1 nguồn chân lý)', () => {
    const gemini = buildGeminiResponseSchema();
    const openai = buildOpenAIJsonSchema();
    assert.deepEqual(Object.keys(gemini.properties).sort(), Object.keys(openai.properties).sort());
    assert.deepEqual([...gemini.required].sort(), [...openai.required].sort());

    const gItem = gemini.properties.items.items;
    const oItem = openai.properties.items.items;
    assert.deepEqual(Object.keys(gItem.properties).sort(), Object.keys(oItem.properties).sort());
    assert.deepEqual([...gItem.required].sort(), [...oItem.required].sort());
  });
});

describe('ai-providers — supportsStructuredOutput registry', () => {
  it('gemini=native, openai/groq=schema, deepseek/openrouter/mistral/qwen/zai=object', () => {
    assert.equal(supportsStructuredOutput('gemini'), 'native');
    assert.equal(supportsStructuredOutput('openai'), 'schema');
    assert.equal(supportsStructuredOutput('groq'), 'schema');
    for (const p of ['deepseek', 'openrouter', 'mistral', 'qwen', 'zai']) {
      assert.equal(supportsStructuredOutput(p), 'object', `${p} phải là 'object'`);
    }
  });

  it('anthropic/local providers = null (prefill / không set response_format)', () => {
    for (const p of ['anthropic', 'ollama', 'lmstudio', 'custom']) {
      assert.equal(supportsStructuredOutput(p), null, `${p} phải là null`);
    }
  });
});

describe('ai-providers — endpoint normalization & testUrl resolution', () => {
  it('normalizeEndpointUrl handles v1, v4 (Z.AI), and full completions URLs', () => {
    assert.equal(normalizeEndpointUrl('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(normalizeEndpointUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(normalizeEndpointUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(normalizeEndpointUrl('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
    assert.equal(normalizeEndpointUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/chat/completions');
  });

  it('resolveTestUrl derives correct /models URL for zai and custom endpoints', () => {
    assert.equal(resolveTestUrl('zai', 'test-key', ''), 'https://open.bigmodel.cn/api/paas/v4/models');
    assert.equal(resolveTestUrl('custom', 'test-key', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'), 'https://open.bigmodel.cn/api/paas/v4/models');
    assert.equal(resolveTestUrl('custom', 'test-key', 'https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/models');
    assert.equal(resolveTestUrl('custom', 'test-key', 'http://127.0.0.1:11434/v1/chat/completions'), 'http://127.0.0.1:11434/v1/models');
  });

  it('zai provider is present in AI_PROVIDERS with valid configuration', () => {
    assert.ok(AI_PROVIDERS.zai, 'Z.AI provider must exist');
    // Default nâng lên dòng Flash free mới nhất (glm-4-flash đã cũ — đối chiếu docs 9/2026)
    assert.equal(AI_PROVIDERS.zai.defaultModel, 'glm-4.7-flash');
    assert.equal(AI_PROVIDERS.zai.endpoint, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(AI_PROVIDERS.zai.auth, 'bearer');
    assert.equal(AI_PROVIDERS.zai.api, 'openai');
  });
});

