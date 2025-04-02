import { supabase } from '../lib/supabase.js';
import Sentry from '../lib/sentry.js';
import crypto from 'crypto';

/**
 * @fileoverview Implementação das ações do sistema para o AgentIA.
 * 
 * Este módulo contém as implementações de ferramentas do sistema que podem ser usadas
 * pelo AgentIA, como agendamento, atualização de cliente, atualização de chat e início de fluxo.
 * 
 * Cada tipo de ferramenta tem duas partes principais:
 * 1. Uma função de geração que cria a definição da ferramenta para o modelo OpenAI
 * 2. Uma função de processamento que executa a ação quando chamada
 */

/**
 * Cache para mapeamentos de nome para ID
 * Estrutura:
 * {
 *   [organizationId]: {
 *     services: {
 *       [scheduleId]: {
 *         data: { [lowercaseName]: id, ... },
 *         timestamp: Date timestamp
 *       }
 *     },
 *     providers: {
 *       [scheduleId]: {
 *         data: { [lowercaseName]: id, ... },
 *         timestamp: Date timestamp
 *       }
 *     },
 *     teams: {
 *       data: { [lowercaseName]: id, ... },
 *       timestamp: Date timestamp
 *     },
 *     flows: {
 *       data: { [lowercaseName]: id, ... },
 *       timestamp: Date timestamp
 *     }
 *   }
 * }
 */
const nameToIdCache = {};

// Tempo de expiração do cache em ms (1 hora)
const CACHE_EXPIRATION = 60 * 60 * 1000;

/**
 * Verifica se o cache está válido (não expirado)
 * @param {number} timestamp - Timestamp do cache
 * @returns {boolean} - True se o cache estiver válido
 */
const isCacheValid = (timestamp) => {
  return timestamp && (Date.now() - timestamp) < CACHE_EXPIRATION;
};

/**
 * Obtém um mapeamento do cache
 * @param {string} organizationId - ID da organização
 * @param {string} type - Tipo de mapeamento (services, providers, teams, flows)
 * @param {string} [subKey] - Chave adicional para o cache (ex: scheduleId)
 * @returns {Object|null} - Mapeamento ou null se não estiver em cache
 */
const getCachedMap = (organizationId, type, subKey = null) => {
  if (!nameToIdCache[organizationId]) return null;
  
  // Para serviços e profissionais, precisamos de uma subKey (scheduleId)
  if ((type === 'services' || type === 'providers') && !subKey) return null;
  
  const cache = nameToIdCache[organizationId];
  
  // Serviços e profissionais são organizados por agenda
  if (type === 'services' || type === 'providers') {
    if (!cache[type] || !cache[type][subKey]) return null;
    
    const typeCache = cache[type][subKey];
    if (!isCacheValid(typeCache.timestamp)) return null;
    
    return typeCache.data;
  }
  
  // Equipes e fluxos são organizados apenas por organização
  if (!cache[type]) return null;
  
  const typeCache = cache[type];
  if (!isCacheValid(typeCache.timestamp)) return null;
  
  return typeCache.data;
};

/**
 * Armazena um mapeamento no cache
 * @param {string} organizationId - ID da organização
 * @param {string} type - Tipo de mapeamento (services, providers, teams, flows)
 * @param {Object} map - Mapeamento a ser armazenado
 * @param {string} [subKey] - Chave adicional para o cache (ex: scheduleId)
 */
const setCachedMap = (organizationId, type, map, subKey = null) => {
  if (!organizationId) return;
  
  // Inicializar o cache da organização se necessário
  if (!nameToIdCache[organizationId]) {
    nameToIdCache[organizationId] = {
      services: {},
      providers: {},
      teams: null,
      flows: null
    };
  }
  
  const timestamp = Date.now();
  
  // Serviços e profissionais são organizados por agenda
  if ((type === 'services' || type === 'providers') && subKey) {
    if (!nameToIdCache[organizationId][type]) {
      nameToIdCache[organizationId][type] = {};
    }
    
    nameToIdCache[organizationId][type][subKey] = {
      data: map,
      timestamp
    };
    return;
  }
  
  // Equipes e fluxos são organizados apenas por organização
  nameToIdCache[organizationId][type] = {
    data: map,
    timestamp
  };
};

/**
 * Transforma uma string para seguir o padrão ^[a-zA-Z0-9_-]+$
 * @param {string} name - Nome original
 * @returns {string} - Nome transformado
 */
const transformToolName = (name) => {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_') // Substitui caracteres não alfanuméricos por underscore
    .replace(/_+/g, '_') // Remove underscores duplicados
    .replace(/^_|_$/g, ''); // Remove underscores do início e fim
};

/**
 * Gera ferramentas do sistema com base nas ações configuradas
 * @param {string} organizationId - ID da organização
 * @param {Array<Object>} systemActions - Array de ações do sistema configuradas, incluindo nome, descrição e tipo
 * @returns {Promise<Array>} - Lista de ferramentas geradas
 */
export const generateSystemTools = async (organizationId, systemActions = []) => {
  try {
    console.log(`[generateSystemTools] Gerando ferramentas do sistema para organização ${organizationId}`);
    const tools = [];
    
    // Para cada ação do sistema, gerar a ferramenta correspondente
    for (const action of systemActions) {
      if (!action || !action.type) continue;
      
      let tool = null;
      const actionType = action.type;
      
      switch (actionType) {
        case 'schedule':
          tool = await generateScheduleTool(organizationId, action);
          break;
        case 'update_customer':
          tool = generateUpdateCustomerTool(action);
          break;
        case 'update_chat':
          tool = generateUpdateChatTool(action);
          break;
        case 'start_flow':
          tool = await generateStartFlowTool(organizationId, action);
          break;
        default:
          console.log(`[generateSystemTools] Tipo de ação desconhecido: ${actionType}`);
          continue;
      }
      
      if (tool) {
        tools.push(tool);
      }
    }
    
    return tools;
  } catch (error) {
    console.error(`[generateSystemTools] Erro ao gerar ferramentas do sistema:`, error);
    Sentry.captureException(error);
    return [];
  }
};

/**
 * Gera a ferramenta para agendamento
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Promise<Object>} - Ferramenta de agendamento
 */
const generateScheduleTool = async (organizationId, action) => {
    if (!action.config.schedule) {
        console.log(`[generateScheduleTool] Nenhuma agenda configurada para a ação ${action.name}`);
        return null;
    }
  try {
    // Verificar se há uma agenda configurada o tool
    const { data: schedules, error } = await supabase
      .from('schedules')
      .select('id, title')
      .eq('organization_id', organizationId)
      .eq('id', action.config.schedule)
      .eq('status', 'active');
    
    if (error) {
      throw error;
    }
    
    if (!schedules || schedules.length === 0) {
      console.log(`[generateScheduleTool] Nenhuma agenda encontrada para a organização ${organizationId}`);
      return null;
    }
    
    // Para simplificar, usar a primeira agenda encontrada
    const scheduleId = schedules[0].id;
    const scheduleName = schedules[0].title;
    
    // Buscar serviços da agenda
    const { data: services, error: servicesError } = await supabase
      .from('schedule_services')
      .select('id, title')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (servicesError) {
      throw servicesError;
    }
    
    // Buscar providers da agenda
    const { data: providers, error: providersError } = await supabase
      .from('schedule_providers')
      .select(`
        id, 
        profiles(
          id, 
          full_name
        )
      `)
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (providersError) {
      throw providersError;
    }
    
    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = transformToolName(action.name || "schedule_appointment");
    const toolDescription = action.description || 
      `Agendar, consultar ou cancelar compromissos na agenda "${scheduleName}". Use esta ferramenta quando o cliente quiser agendar, verificar disponibilidade ou cancelar um agendamento existente.`;
    
    // Construir a ferramenta para agendamento
    return {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["checkAvailability", "createAppointment", "checkAppointment", "deleteAppointment"],
            description: "Operação a ser realizada no sistema de agendamento."
          },
          date: {
            type: "string",
            description: "Data para o agendamento no formato YYYY-MM-DD (ex: 2023-12-31)."
          },
          time: {
            type: "string",
            description: "Horário para o agendamento no formato HH:MM (ex: 14:30)."
          },
          ...(services && services.length > 0 ? {
            service_name: {
              type: "string",
              enum: services.map(service => service.title),
              description: "Nome do serviço a ser agendado."
            }
          } : {}),
          ...(providers && providers.length > 0 && providers.some(p => p.profiles?.full_name) ? {
            provider_name: {
              type: "string",
              enum: providers.map(provider => provider.profiles?.full_name).filter(name => name),
              description: "Nome do profissional que realizará o atendimento."
            }
          } : {}),
          notes: {
            type: "string",
            description: "Observações ou notas adicionais para o agendamento."
          },
          appointment_id: {
            type: "string",
            description: "ID do agendamento para operações de consulta ou cancelamento."
          }
        },
        required: ["operation"]
      }
    };
  } catch (error) {
    console.error(`[generateScheduleTool] Erro ao gerar ferramenta de agendamento:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Gera a ferramenta para atualizar dados do cliente
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Object} - Ferramenta de atualização de cliente
 */
const generateUpdateCustomerTool = (action) => {
  // Usar o nome e a descrição da ação configurada ou usar padrões
  const toolName = transformToolName(action.title || "update_customer");
  const toolDescription = action.description || 
    "Atualizar informações do cliente, como nome, email, telefone ou estágio no funil.";
  
  return {
    name: toolName,
    description: toolDescription,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Novo nome para o cliente."
        },
        email: {
          type: "string",
          description: "Novo endereço de email para o cliente."
        },
        phone: {
          type: "string",
          description: "Novo número de telefone para o cliente."
        },
        funnel_stage: {
          type: "string",
          description: "Estágio do funil para o qual o cliente deve ser movido. Use o nome do estágio."
        },
        tags: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Tags a serem aplicadas ao cliente."
        }
      }
    }
  };
};

/**
 * Gera a ferramenta para atualizar dados do chat
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Object} - Ferramenta de atualização de chat
 */
const generateUpdateChatTool = (action) => {
  // Usar o nome e a descrição da ação configurada ou usar padrões
  const toolName = transformToolName(action.name || "update_chat");
  const toolDescription = action.description || 
    "Atualizar informações do chat atual, como título, status ou equipe responsável.";
  
  return {
    name: toolName,
    description: toolDescription,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Novo título para o chat."
        },
        status: {
          type: "string",
          enum: ["in_progress", "waiting", "closed", "transferred"],
          description: "Novo status para o chat."
        },
        team_name: {
          type: "string",
          description: "Nome da equipe que deve ser responsável pelo chat."
        }
      }
    }
  };
};

/**
 * Gera a ferramenta para iniciar um fluxo automatizado
 * @param {string} organizationId - ID da organização
 * @param {Object} action - Ação associada à ferramenta
 * @returns {Promise<Object>} - Ferramenta de início de fluxo
 */
const generateStartFlowTool = async (organizationId, action) => {
  try {
    // Buscar fluxos disponíveis para a organização
    const { data: flows, error } = await supabase
      .from('flows')
      .select('id, name')
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    
    if (error) {
      throw error;
    }
    
    if (!flows || flows.length === 0) {
      console.log(`[generateStartFlowTool] Nenhum fluxo encontrado para a organização ${organizationId}`);
      return null;
    }
    
    // Usar o nome e a descrição da ação configurada ou usar padrões
    const toolName = transformToolName(action.name || "start_flow");
    const toolDescription = action.description || 
      "Iniciar um fluxo de automação para processar uma tarefa específica.";
    
    return {
      name: toolName,
      description: toolDescription,
      parameters: {
        type: "object",
        properties: {
          flow_name: {
            type: "string",
            enum: flows.map(flow => flow.name),
            description: "Nome do fluxo a ser iniciado."
          },
          variables: {
            type: "object",
            description: "Variáveis a serem passadas para o fluxo.",
            additionalProperties: true
          }
        },
        required: ["flow_name"]
      }
    };
  } catch (error) {
    console.error(`[generateStartFlowTool] Erro ao gerar ferramenta de início de fluxo:`, error);
    Sentry.captureException(error);
    return null;
  }
};

/**
 * Cria um mapa de nome para ID a partir de uma lista de itens
 * @param {Array} items - Lista de itens com nome e ID
 * @param {string} nameKey - Nome da propriedade que contém o nome
 * @param {string} idKey - Nome da propriedade que contém o ID
 * @returns {Object} - Mapa de nome para ID
 */
const createNameToIdMap = (items, nameKey = 'name', idKey = 'id') => {
  const map = {};
  if (!items || !Array.isArray(items)) return map;
  
  for (const item of items) {
    if (!item) continue; // Pular itens nulos ou undefined
    
    // Lidar com casos onde o nome está aninhado (como em profiles.full_name)
    let name = item[nameKey];
    if (!name && nameKey.includes('.')) {
      try {
        const keys = nameKey.split('.');
        let nested = item;
        for (const key of keys) {
          if (!nested) break;
          nested = nested[key];
        }
        name = nested;
      } catch (error) {
        console.warn(`[createNameToIdMap] Erro ao acessar propriedade aninhada '${nameKey}':`, error);
        continue; // Pular este item se houver erro
      }
    }
    
    // Lidar com casos onde o ID está aninhado
    let id = item[idKey];
    if (!id && idKey.includes('.')) {
      try {
        const keys = idKey.split('.');
        let nested = item;
        for (const key of keys) {
          if (!nested) break;
          nested = nested[key];
        }
        id = nested;
      } catch (error) {
        console.warn(`[createNameToIdMap] Erro ao acessar propriedade aninhada '${idKey}':`, error);
        continue; // Pular este item se houver erro
      }
    }
    
    if (name && id) {
      map[name.toLowerCase()] = id;
    }
  }
  
  return map;
};

/**
 * Processa chamadas para ferramentas do sistema
 * @param {string} tool - Ferramenta do sistema  a ser processada
 * @param {Object} args - Argumentos da chamada
 * @param {Object} session - Sessão atual
 * @param {Function} processUpdateCustomerAction - Função para processar ação de atualização de cliente
 * @param {Function} processUpdateChatAction - Função para processar ação de atualização de chat
 * @param {Function} processStartFlowAction - Função para processar ação de início de fluxo
 * @returns {Object|Array} - Resultado(s) da operação
 */
export const handleSystemToolCall = async (
  tool, 
  args, 
  actionsSystem,
  session, 
  { 
    processUpdateCustomerAction, 
    processUpdateChatAction, 
    processStartFlowAction 
  }
) => {
  try {
    console.log(`[handleSystemToolCall] Processando chamada para ferramenta do sistema: ${tool.name}`);

    // console.log(`[handleSystemToolCall] Ferramentas disponíveis: ${JSON.stringify(actionsSystem)}`);

    const action = actionsSystem.find(action => action.name === tool.name);

    console.log(`[handleSystemToolCall] Ferramenta encontrada: ${JSON.stringify(action)}`);
    console.log(`[handleSystemToolCall] Ferramenta config: ${JSON.stringify(action.config)}`);

    switch (action.type) {
      case 'schedule': {
        if (!action.config.schedule) {
          console.log(`[handleSystemToolCall] Agenda não existe`);
          return {
            status: "error",
            message: "Schedule ID is required."
          };
        }
        // Buscar a agenda configurada
        const { data: schedules, error: schedulesError } = await supabase
          .from('schedules')
          .select('id, title')
          .eq('organization_id', session.organization_id)
          .eq('id', action.config.schedule)
          .eq('status', 'active');

        console.log(`[handleSystemToolCall] Agenda: ${JSON.stringify(schedules)}`);
        
        if (schedulesError) {
          return {
            status: "error",
            message: "No active schedules found for this organization.",
          };
        }

        if (!schedules || schedules.length === 0) {
          return {
            status: "error",
            message: "No active schedules found for this organization.",
          };
        }
        
        // Usar a primeira agenda disponível
        const scheduleId = schedules[0].id;
        console.log(`[handleSystemToolCall] Usando agenda: ${scheduleId}`);
        
        // Processar mapeamento de nome para ID apenas se os argumentos correspondentes estiverem presentes
        
        // 1. Mapear service_name para service_id se fornecido
        if (args.service_name) {
          // Verificar se existe no cache
          let serviceMap = getCachedMap(session.organization_id, 'services', scheduleId);
          
          // Se não existir no cache, buscar e armazenar
          if (!serviceMap) {
            const { data: services } = await supabase
              .from('schedule_services')
              .select('id, title')
              .eq('schedule_id', scheduleId)
              .eq('status', 'active');
            
            if (!services || services.length === 0) {
              console.warn(`[handleSystemToolCall] Nenhum serviço encontrado para a agenda ${scheduleId}`);
              return {
                status: "error",
                message: "No services found for this schedule.",
              };
            }
            
            // Criar e armazenar o mapa no cache
            serviceMap = createNameToIdMap(services, 'title', 'id');
            setCachedMap(session.organization_id, 'services', serviceMap, scheduleId);
            console.log(`[handleSystemToolCall] Cache de serviços criado para organização ${session.organization_id}, agenda ${scheduleId}`);
          } else {
            console.log(`[handleSystemToolCall] Usando cache de serviços para organização ${session.organization_id}, agenda ${scheduleId}`);
          }
          
          const serviceName = args.service_name.toLowerCase();
          
          if (serviceMap[serviceName]) {
            args.service_id = serviceMap[serviceName];
            console.log(`[handleSystemToolCall] Mapeado nome do serviço "${args.service_name}" para ID: ${args.service_id}`);
          } else {
            console.warn(`[handleSystemToolCall] Serviço "${args.service_name}" não encontrado`);
            return {
              status: "error",
              message: `Service "${args.service_name}" not found. Please choose a valid service.`,
            };
          }
        }
        
        // 2. Mapear provider_name para provider_id se fornecido
        if (args.provider_name) {
          // Verificar se existe no cache
          let providerMap = getCachedMap(session.organization_id, 'providers', scheduleId);
          
          // Se não existir no cache, buscar e armazenar
          if (!providerMap) {
            const { data: providers } = await supabase
              .from('schedule_providers')
              .select(`
                id,
                profiles(id, full_name)
              `)
              .eq('schedule_id', scheduleId)
              .eq('status', 'active');
            
            if (!providers || providers.length === 0) {
              console.warn(`[handleSystemToolCall] Nenhum profissional encontrado para a agenda ${scheduleId}`);
              // Não retornar erro, pois é opcional
            } else {
              // Criar e armazenar o mapa no cache
              providerMap = createNameToIdMap(providers.map(p => p.profiles), 'full_name', 'id');
              setCachedMap(session.organization_id, 'providers', providerMap, scheduleId);
              console.log(`[handleSystemToolCall] Cache de profissionais criado para organização ${session.organization_id}, agenda ${scheduleId}`);
            }
          } else {
            console.log(`[handleSystemToolCall] Usando cache de profissionais para organização ${session.organization_id}, agenda ${scheduleId}`);
          }
          
          if (providerMap) {
            const providerName = args.provider_name.toLowerCase();
            
            if (providerMap[providerName]) {
              args.provider_id = providerMap[providerName];
              console.log(`[handleSystemToolCall] Mapeado nome do profissional "${args.provider_name}" para ID: ${args.provider_id}`);
            } else {
              console.warn(`[handleSystemToolCall] Profissional "${args.provider_name}" não encontrado`);
              // Não retornar erro se o profissional não for encontrado, pois ele é opcional
              // O sistema irá alocar um profissional automaticamente
            }
          }
        }
        
        // Criar uma ação para processamento pelo processCheckScheduleAction
        const actionReturn = {
          type: args.operation,
          config: {
            scheduleId: scheduleId,
            operation: args.operation,
            date: args.date,
            time: args.time,
            appointmentId: args.appointmentId,
            serviceId: args.serviceId,
            notes: args.notes
          }
        };

        console.log(`[handleSystemToolCall] Ação de agendamento retornada: ${JSON.stringify(actionReturn)}`);
        
        // Processar a ação
        return await processCheckScheduleAction(actionReturn, args, session);
      }
      
      case 'update_customer': {
        // Criar uma ação para processamento pelo processUpdateCustomerAction
        const action = {
          type: 'update_customer',
          config: {
            name: args.name,
            // Mapeamento para funil/estágio se necessário
            // Isso seria expandido conforme necessidade
          }
        };
        
        // Processar a ação
        return await processUpdateCustomerAction(action, args, session);
      }
      
      case 'update_chat': {
        // Mapear nome da equipe para ID apenas se fornecido
        if (args.team_name) {
          // Verificar se existe no cache
          let teamMap = getCachedMap(session.organization_id, 'teams');
          
          // Se não existir no cache, buscar e armazenar
          if (!teamMap) {
            const { data: teams } = await supabase
              .from('teams')
              .select('id, name')
              .eq('organization_id', session.organization_id);
            
            if (!teams || teams.length === 0) {
              console.log(`[handleSystemToolCall] Nenhuma equipe encontrada, ignorando atribuição de equipe`);
              // Não impedir a ação se não houver equipes, apenas ignorar este campo
            } else {
              // Criar e armazenar o mapa no cache
              teamMap = createNameToIdMap(teams);
              setCachedMap(session.organization_id, 'teams', teamMap);
              console.log(`[handleSystemToolCall] Cache de equipes criado para organização ${session.organization_id}`);
            }
          } else {
            console.log(`[handleSystemToolCall] Usando cache de equipes para organização ${session.organization_id}`);
          }
          
          if (teamMap) {
            const teamName = args.team_name.toLowerCase();
            
            if (teamMap[teamName]) {
              args.team_id = teamMap[teamName];
              console.log(`[handleSystemToolCall] Mapeado nome da equipe "${args.team_name}" para ID: ${args.team_id}`);
            } else {
              console.warn(`[handleSystemToolCall] Equipe "${args.team_name}" não encontrada`);
              return {
                status: "error",
                message: `Team "${args.team_name}" not found. Please choose a valid team.`,
              };
            }
          }
        }
        
        // Criar uma ação para processamento pelo processUpdateChatAction
        const action = {
          type: 'update_chat',
          config: {
            title: args.title,
            status: args.status,
            teamId: args.team_id
          }
        };
        
        // Processar a ação
        return await processUpdateChatAction(action, args, session);
      }
      
      case 'start_flow': {
        // Verificar se flow_name foi fornecido (obrigatório)
        if (!args.flow_name) {
          return {
            status: "error",
            message: "Flow name is required."
          };
        }
        
        // Mapear nome do fluxo para ID
        // Verificar se existe no cache
        let flowMap = getCachedMap(session.organization_id, 'flows');
        
        // Se não existir no cache, buscar e armazenar
        if (!flowMap) {
          const { data: flows } = await supabase
            .from('flows')
            .select('id, name')
            .eq('organization_id', session.organization_id)
            .eq('is_active', true);
          
          if (!flows || flows.length === 0) {
            console.warn(`[handleSystemToolCall] Nenhum fluxo encontrado para a organização ${session.organization_id}`);
            return {
              status: "error",
              message: "No active flows found for this organization.",
            };
          }
          
          // Criar e armazenar o mapa no cache
          flowMap = createNameToIdMap(flows);
          setCachedMap(session.organization_id, 'flows', flowMap);
          console.log(`[handleSystemToolCall] Cache de fluxos criado para organização ${session.organization_id}`);
        } else {
          console.log(`[handleSystemToolCall] Usando cache de fluxos para organização ${session.organization_id}`);
        }
        
        const flowName = args.flow_name.toLowerCase();
        
        if (flowMap[flowName]) {
          args.flow_id = flowMap[flowName];
          console.log(`[handleSystemToolCall] Mapeado nome do fluxo "${args.flow_name}" para ID: ${args.flow_id}`);
        } else {
          console.warn(`[handleSystemToolCall] Fluxo "${args.flow_name}" não encontrado`);
          return {
            status: "error",
            message: `Flow "${args.flow_name}" not found. Please choose a valid flow.`,
          };
        }
        
        // Criar uma ação para processamento pelo processStartFlowAction
        const action = {
          type: 'start_flow',
          config: {
            flowId: args.flow_id
          }
        };
        
        // Processar a ação
        return await processStartFlowAction(action, args, session);
      }
      
      default:
        console.warn(`[handleSystemToolCall] Ferramenta do sistema não reconhecida: ${tool.name}`);
        return {
          status: "error",
          message: `Unrecognized system tool: ${tool.name}`
        };
    }
  } catch (error) {
    console.error(`[handleSystemToolCall] Erro ao processar ferramenta do sistema ${tool.name}:`, error);
    Sentry.captureException(error);
    return {
      status: "error",
      message: `Error processing system tool ${tool.name}: ${error.message}`
    };
  }
};

/**
 * Limpa um item específico do cache
 * @param {string} organizationId - ID da organização
 * @param {string} type - Tipo de mapeamento (services, providers, teams, flows)
 * @param {string} [subKey] - Chave adicional para o cache (ex: scheduleId)
 */
const clearCacheItem = (organizationId, type, subKey = null) => {
  if (!organizationId || !nameToIdCache[organizationId]) return;
  
  if ((type === 'services' || type === 'providers') && subKey) {
    if (nameToIdCache[organizationId][type] && nameToIdCache[organizationId][type][subKey]) {
      delete nameToIdCache[organizationId][type][subKey];
      console.log(`[clearCacheItem] Cache de ${type} limpo para agenda ${subKey} na organização ${organizationId}`);
    }
    return;
  }
  
  if (nameToIdCache[organizationId][type]) {
    delete nameToIdCache[organizationId][type];
    console.log(`[clearCacheItem] Cache de ${type} limpo para organização ${organizationId}`);
  }
};

/**
 * Limpa todo o cache de uma organização
 * @param {string} organizationId - ID da organização
 */
const clearOrganizationCache = (organizationId) => {
  if (organizationId && nameToIdCache[organizationId]) {
    delete nameToIdCache[organizationId];
    console.log(`[clearOrganizationCache] Todo o cache limpo para organização ${organizationId}`);
  }
};

/**
 * Limpa todo o cache
 */
const clearAllCache = () => {
  Object.keys(nameToIdCache).forEach(key => delete nameToIdCache[key]);
  console.log(`[clearAllCache] Cache global limpo`);
};

/**
 * Processa uma ação de verificação de agenda para ferramentas do sistema
 * @param {Object} action - Configuração da ação
 * @param {Object} args - Argumentos da ferramenta
 * @param {Object} session - Sessão atual
 * @returns {Promise<Object>} - Resultado da operação
 */
const processCheckScheduleAction = async (action, args, session) => {
  try {
    const config = action?.config || {};
    
    // Extrair os argumentos principais
    const operation = args.operation;
    const date = args.date;
    const time = args.time;
    const appointmentId = args.appointment_id;
    const serviceId = args.service_id;
    const providerId = args.provider_id;
    const notes = args.notes;
    
    // Verificar se a operação foi fornecida
    if (!operation) {
      return {
        status: "error",
        message: "Operation parameter is required for schedule actions."
      };
    }
    
    // Identificar o ID da agenda a ser usada
    const scheduleId = config.scheduleId;
    if (!scheduleId) {
      return {
        status: "error",
        message: "No schedule configured for this action."
      };
    }
    
    console.log(`[processCheckScheduleAction] Operação: ${operation}, Data: ${date}, Hora: ${time}, Serviço: ${serviceId}, Agenda: ${scheduleId}`);
    
    // Obter o timezone da agenda
    const { data: scheduleData } = await supabase
      .from('schedules')
      .select('timezone, title')
      .eq('id', scheduleId)
      .single();
    
    const timezone = scheduleData?.timezone || 'America/Sao_Paulo';
    const scheduleName = scheduleData?.title || 'Agenda';
    
    // Buscar informações do serviço se fornecido
    let serviceName = "Serviço não especificado";
    let serviceInfo = null;
    
    if (serviceId) {
      const { data: service } = await supabase
        .from('schedule_services')
        .select('title, by_arrival_time, capacity')
        .eq('id', serviceId)
        .single();
        
      if (service) {
        serviceName = service.title;
        serviceInfo = service;
      }
    }
    
    // Executar a operação apropriada
    let result;
    
    switch (operation) {
      case 'checkAvailability':
        // Verificar disponibilidade de horários
        result = await checkAvailability(scheduleId, date, time, serviceId, timezone);
        break;
        
      case 'createAppointment':
        // Validar parâmetros necessários
        if (!date || !serviceId) {
          const missingParams = [];
          if (!date) missingParams.push('date');
          if (!serviceId) missingParams.push('service_id');
          
          return {
            status: "error",
            message: `Missing required parameters: ${missingParams.join(', ')}`
          };
        }
        
        // Criar agendamento
        result = await createAppointment(scheduleId, session.customer_id, date, time, serviceId, notes, providerId, timezone, session);
        break;
        
      case 'checkAppointment':
        // Consultar agendamentos
        result = await checkAppointment(session.customer_id, appointmentId, scheduleId);
        break;
        
      case 'deleteAppointment':
        // Validar parâmetros necessários
        if (!appointmentId && !date) {
          return {
            status: "error",
            message: "Either appointment_id or date is required to cancel appointments."
          };
        }
        
        // Cancelar agendamento
        result = await deleteAppointment(appointmentId, session.customer_id, date, scheduleId);
        break;
        
      default:
        return {
          status: "error",
          message: `Unsupported operation: ${operation}`
        };
    }
    
    // Adicionar informações de contexto ao resultado
    const enrichedResult = {
      ...result,
      status: result.success ? "success" : "error",
      operation: operation,
      data: {
        ...result,
        service_name: serviceName,
        schedule_name: scheduleName,
        appointment_date: date,
        appointment_time: time,
        timezone: timezone
      }
    };
    
    return enrichedResult;
    
  } catch (error) {
    console.error('[processCheckScheduleAction] Error:', error);
    Sentry.captureException(error);
    return {
      status: "error",
      message: `Error processing schedule action: ${error.message}`
    };
  }
};

/**
 * Verifica disponibilidade de horários
 * @param {string} scheduleId - ID da agenda
 * @param {string} date - Data para verificação
 * @param {string} time - Horário específico (opcional)
 * @param {string} serviceId - ID do serviço
 * @param {string} timezone - Timezone da agenda
 * @returns {Promise<Object>} - Resultado da verificação
 */
const checkAvailability = async (scheduleId, date, time, serviceId, timezone) => {
  try {
    // Verificar se a agenda existe
    const { data: schedule, error: scheduleError } = await supabase
      .from('schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();
      
    if (scheduleError || !schedule) {
      return {
        success: false,
        message: `Schedule not found with ID ${scheduleId}`
      };
    }
    
    // Buscar informações do serviço se fornecido
    let serviceName = "Service not specified";
    let serviceDuration = 30; // Duração padrão em minutos
    let isByArrivalTime = false;
    
    if (serviceId) {
      const { data: service } = await supabase
        .from('schedule_services')
        .select('title, duration, by_arrival_time')
        .eq('id', serviceId)
        .single();
        
      if (service) {
        serviceName = service.title;
        isByArrivalTime = service.by_arrival_time || false;
        
        // Converter duração para minutos
        try {
          const durationParts = service.duration.toString().split(':');
          serviceDuration = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
        } catch (e) {
          console.warn(`Erro ao converter duração: ${service.duration}`, e);
        }
      }
    }
    
    // Formatar data para exibição
    const formattedDate = new Date(date).toLocaleDateString('pt-BR');
    
    // Buscar horários disponíveis
    const availableSlots = await getAvailableSlots(scheduleId, date, serviceId, serviceDuration, isByArrivalTime);
    
    // Se não foi especificado um horário, retornar todos os slots disponíveis
    if (!time) {
      return {
        success: true,
        available: availableSlots.length > 0,
        date: date,
        formatted_date: formattedDate,
        available_times: availableSlots,
        message: availableSlots.length > 0
          ? `${availableSlots.length} time slots available on ${formattedDate}`
          : `No available slots on ${formattedDate}`
      };
    }
    
    // Verificar se o horário específico está disponível
    const isAvailable = availableSlots.includes(time);
    
    return {
      success: true,
      available: isAvailable,
      date: date,
      formatted_date: formattedDate,
      requested_time: time,
      available_times: availableSlots,
      message: isAvailable
        ? `Slot available on ${formattedDate} at ${time}`
        : `No availability on ${formattedDate} at ${time}`
    };
  } catch (error) {
    console.error('[checkAvailability] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error checking availability: ${error.message}`
    };
  }
};

/**
 * Função simplificada para obter slots disponíveis
 * @param {string} scheduleId - ID da agenda
 * @param {string} date - Data para verificação
 * @param {string} serviceId - ID do serviço
 * @param {number} duration - Duração do serviço em minutos
 * @param {boolean} isByArrivalTime - Se é por ordem de chegada
 * @returns {Promise<Array>} - Lista de horários disponíveis
 */
const getAvailableSlots = async (scheduleId, date, serviceId, duration = 30, isByArrivalTime = false) => {
  // Implementação simplificada que consulta agendamentos existentes e horários de disponibilidade
  try {
    // Obter todos os providers ativos para esta agenda
    const { data: providers } = await supabase
      .from('schedule_providers')
      .select('id, profile_id')
      .eq('schedule_id', scheduleId)
      .eq('status', 'active');
    
    if (!providers || providers.length === 0) {
      return [];
    }
    
    // Calcular o dia da semana (0-6, onde 0 é domingo)
    const dateObj = new Date(`${date}T12:00:00Z`);
    const dayOfWeek = dateObj.getDay();
    
    // Buscar disponibilidade para o dia da semana
    const { data: availabilities } = await supabase
      .from('schedule_availability')
      .select('provider_id, start_time, end_time')
      .in('provider_id', providers.map(p => p.id))
      .eq('day_of_week', dayOfWeek);
    
    if (!availabilities || availabilities.length === 0) {
      return [];
    }
    
    // Buscar agendamentos existentes para a data
    const { data: existingAppointments } = await supabase
      .from('appointments')
      .select('provider_id, start_time, end_time')
      .eq('schedule_id', scheduleId)
      .eq('date', date)
      .not('status', 'in', '(canceled)');
    
    // Horários de início e fim das disponibilidades
    const allSlots = [];
    
    // Para cada disponibilidade, gerar slots possíveis
    availabilities.forEach(availability => {
      const startMinutes = timeToMinutes(availability.start_time);
      const endMinutes = timeToMinutes(availability.end_time);
      
      // Define o intervalo de slot com base na configuração ou usa 30 minutos como padrão
      const slotInterval = 30;
      
      // Gerar todos os slots possíveis
      for (let slot = startMinutes; slot <= endMinutes - duration; slot += slotInterval) {
        const slotTime = minutesToTime(slot);
        
        // Verificar se o slot já está ocupado
        const isOccupied = existingAppointments?.some(apt => {
          const aptStart = timeToMinutes(apt.start_time);
          const aptEnd = timeToMinutes(apt.end_time);
          return aptStart <= slot && aptEnd > slot;
        });
        
        if (!isOccupied && !allSlots.includes(slotTime)) {
          allSlots.push(slotTime);
        }
      }
    });
    
    // Ordenar e retornar os slots disponíveis
    return allSlots.sort();
  } catch (error) {
    console.error('[getAvailableSlots] Error:', error);
    Sentry.captureException(error);
    return [];
  }
};

/**
 * Cria um novo agendamento
 * @param {string} scheduleId - ID da agenda
 * @param {string} customerId - ID do cliente
 * @param {string} date - Data do agendamento
 * @param {string} time - Hora do agendamento
 * @param {string} serviceId - ID do serviço
 * @param {string} notes - Observações
 * @param {string} providerId - ID do profissional (opcional)
 * @param {string} timezone - Timezone da agenda
 * @param {Object} session - Sessão atual
 * @returns {Promise<Object>} - Resultado da criação
 */
const createAppointment = async (scheduleId, customerId, date, time, serviceId, notes, providerId, timezone, session) => {
  try {
    // Verificar se o horário está disponível
    const availabilityCheck = await checkAvailability(scheduleId, date, time, serviceId, timezone);
    
    if (!availabilityCheck.available) {
      return {
        success: false,
        message: `The requested time slot is not available. Available times: ${availabilityCheck.available_times.join(', ')}`
      };
    }
    
    // Buscar informações do serviço
    const { data: serviceData } = await supabase
      .from('schedule_services')
      .select('title, duration, by_arrival_time')
      .eq('id', serviceId)
      .single();
    
    if (!serviceData) {
      return {
        success: false,
        message: `Service not found with ID ${serviceId}`
      };
    }
    
    // Calcular horário de término
    let endTime = time;
    try {
      const durationParts = serviceData.duration.toString().split(':');
      const durationMinutes = parseInt(durationParts[0]) * 60 + parseInt(durationParts[1]);
      
      const [hours, minutes] = time.split(':').map(Number);
      const startMinutes = hours * 60 + minutes;
      const endMinutes = startMinutes + durationMinutes;
      
      const endHours = Math.floor(endMinutes / 60);
      const endMins = endMinutes % 60;
      
      endTime = `${endHours.toString().padStart(2, '0')}:${endMins.toString().padStart(2, '0')}`;
    } catch (e) {
      console.warn(`Erro ao calcular horário de término`, e);
    }
    
    // Se não foi especificado um profissional, encontrar um disponível
    let selectedProviderId = providerId;
    if (!selectedProviderId) {
      const { data: availableProvider } = await supabase
        .from('schedule_providers')
        .select('profile_id')
        .eq('schedule_id', scheduleId)
        .eq('status', 'active')
        .limit(1)
        .single();
      
      if (availableProvider) {
        selectedProviderId = availableProvider.profile_id;
      }
    }
    
    // Criar o agendamento
    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert({
        schedule_id: scheduleId,
        customer_id: customerId,
        provider_id: selectedProviderId,
        service_id: serviceId,
        date: date,
        start_time: time,
        end_time: endTime,
        status: 'scheduled',
        notes: notes || '',
        chat_id: session.chat_id,
        metadata: {
          created_via: 'agent_ia_action',
          creation_date: new Date().toISOString()
        }
      })
      .select()
      .single();
    
    if (error) {
      throw error;
    }
    
    // Formatar a data para exibição
    const formattedDate = new Date(date).toLocaleDateString('pt-BR');
    
    return {
      success: true,
      appointment_id: appointment.id,
      date: date,
      formatted_date: formattedDate,
      time: time,
      end_time: endTime,
      service_id: serviceId,
      service_name: serviceData.title,
      message: `Appointment successfully created for ${formattedDate} at ${time}`
    };
  } catch (error) {
    console.error('[createAppointment] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error creating appointment: ${error.message}`
    };
  }
};

/**
 * Verifica agendamentos de um cliente
 * @param {string} customerId - ID do cliente
 * @param {string} appointmentId - ID do agendamento específico (opcional)
 * @param {string} scheduleId - ID da agenda (opcional)
 * @returns {Promise<Object>} - Resultado da verificação
 */
const checkAppointment = async (customerId, appointmentId, scheduleId) => {
  try {
    // Construir a consulta base
    let query = supabase
      .from('appointments')
      .select(`
        id, 
        date, 
        start_time, 
        end_time, 
        status,
        schedule_id,
        service_id,
        schedules(title),
        schedule_services(title)
      `)
      .eq('customer_id', customerId)
      .in('status', ['scheduled', 'confirmed']);
    
    // Filtrar por agenda se especificado
    if (scheduleId) {
      query = query.eq('schedule_id', scheduleId);
    }
    
    // Filtrar por ID específico se fornecido
    if (appointmentId) {
      query = query.eq('id', appointmentId);
    }
    
    // Ordenar por data e hora
    query = query.order('date', { ascending: true })
                .order('start_time', { ascending: true });
    
    // Executar a consulta
    const { data, error } = await query;
    
    if (error) {
      throw error;
    }
    
    // Formatar os resultados
    const appointments = (data || []).map(apt => ({
      id: apt.id,
      date: apt.date,
      formatted_date: new Date(apt.date).toLocaleDateString('pt-BR'),
      time: apt.start_time,
      end_time: apt.end_time,
      status: apt.status,
      schedule_name: apt.schedules?.title || 'Agenda não especificada',
      service_name: apt.schedule_services?.title || 'Serviço não especificado'
    }));
    
    return {
      success: true,
      appointments: appointments,
      count: appointments.length,
      message: appointments.length > 0
        ? `Found ${appointments.length} appointment(s)`
        : "No appointments found"
    };
  } catch (error) {
    console.error('[checkAppointment] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error checking appointments: ${error.message}`
    };
  }
};

/**
 * Cancela um agendamento
 * @param {string} appointmentId - ID do agendamento
 * @param {string} customerId - ID do cliente
 * @param {string} date - Data para cancelar todos os agendamentos
 * @param {string} scheduleId - ID da agenda (opcional)
 * @returns {Promise<Object>} - Resultado do cancelamento
 */
const deleteAppointment = async (appointmentId, customerId, date, scheduleId) => {
  try {
    // Se temos um ID específico
    if (appointmentId) {
      // Verificar se o agendamento existe e pertence ao cliente
      const { data: appointment, error: fetchError } = await supabase
        .from('appointments')
        .select('*')
        .eq('id', appointmentId)
        .eq('customer_id', customerId)
        .in('status', ['scheduled', 'confirmed'])
        .single();
      
      if (fetchError) {
        return {
          success: false,
          message: `Appointment not found with ID ${appointmentId} or it doesn't belong to this customer`
        };
      }
      
      // Cancelar o agendamento
      const { error: updateError } = await supabase
        .from('appointments')
        .update({ 
          status: 'canceled',
          metadata: {
            ...appointment.metadata,
            canceled_at: new Date().toISOString(),
            canceled_via: 'agent_ia_action'
          }
        })
        .eq('id', appointmentId);
      
      if (updateError) {
        throw updateError;
      }
      
      // Formatar a data para exibição
      const formattedDate = new Date(appointment.date).toLocaleDateString('pt-BR');
      
      return {
        success: true,
        appointment_id: appointmentId,
        date: appointment.date,
        formatted_date: formattedDate,
        time: appointment.start_time,
        message: `Appointment successfully canceled for ${formattedDate} at ${appointment.start_time}`
      };
    }
    
    // Se temos uma data para cancelar todos os agendamentos
    if (date) {
      // Construir a consulta
      let query = supabase
        .from('appointments')
        .select('*')
        .eq('customer_id', customerId)
        .eq('date', date)
        .in('status', ['scheduled', 'confirmed']);
      
      // Filtrar por agenda se especificado
      if (scheduleId) {
        query = query.eq('schedule_id', scheduleId);
      }
      
      // Executar a consulta
      const { data: appointments, error: searchError } = await query;
      
      if (searchError) {
        throw searchError;
      }
      
      if (!appointments || appointments.length === 0) {
        return {
          success: false,
          message: `No appointments found for date ${date}`
        };
      }
      
      // Cancelar todos os agendamentos encontrados
      let canceledCount = 0;
      const canceledAppointments = [];
      
      for (const appointment of appointments) {
        const { error: updateError } = await supabase
          .from('appointments')
          .update({
            status: 'canceled',
            metadata: {
              ...appointment.metadata,
              canceled_at: new Date().toISOString(),
              canceled_via: 'agent_ia_action'
            }
          })
          .eq('id', appointment.id);
        
        if (!updateError) {
          canceledCount++;
          canceledAppointments.push({
            id: appointment.id,
            date: appointment.date,
            time: appointment.start_time
          });
        }
      }
      
      // Formatar a data para exibição
      const formattedDate = new Date(date).toLocaleDateString('pt-BR');
      
      return {
        success: true,
        canceled_count: canceledCount,
        canceled_appointments: canceledAppointments,
        date: date,
        formatted_date: formattedDate,
        message: `Successfully canceled ${canceledCount} appointment(s) for ${formattedDate}`
      };
    }
    
    return {
      success: false,
      message: "Either appointment_id or date is required to cancel appointments"
    };
  } catch (error) {
    console.error('[deleteAppointment] Error:', error);
    Sentry.captureException(error);
    return {
      success: false,
      message: `Error canceling appointment: ${error.message}`
    };
  }
};

/**
 * Helper para converter tempo HH:MM para minutos desde meia-noite
 * @param {string} timeStr - Horário no formato HH:MM
 * @returns {number} - Minutos desde meia-noite
 */
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * Helper para converter minutos desde meia-noite para formato HH:MM
 * @param {number} minutes - Minutos desde meia-noite
 * @returns {string} - Horário no formato HH:MM
 */
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
};

/**
 * Exporta funções para uso em outros módulos
 */
export {
  clearCacheItem,
  clearOrganizationCache,
  clearAllCache,
  nameToIdCache,
  getCachedMap,
  setCachedMap,
  createNameToIdMap,
  processCheckScheduleAction
};